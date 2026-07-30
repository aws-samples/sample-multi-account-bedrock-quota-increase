// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Self-contained AWS IAM Identity Center (SSO) login + per-account credentials.
//
// We run the OAuth 2.0 device-authorization flow ourselves via the SSO-OIDC
// SDK, so the customer does NOT need 30 preconfigured profiles or even a
// working `aws sso login`. They just pass --start-url. The short-lived access
// token is cached under ~/.bqi/ so repeat runs within the session don't
// re-prompt.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} from "@aws-sdk/client-sso-oidc";
import {
  SSOClient,
  ListAccountsCommand,
  ListAccountRolesCommand,
  GetRoleCredentialsCommand,
} from "@aws-sdk/client-sso";
import { log, c } from "./ui.js";

const CACHE_DIR = join(homedir(), ".bqi", "sso-cache");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

export interface AccountCredentials {
  roleName: string;
  credentials: AwsCredentials;
}

export interface SsoAccount {
  accountId: string;
  accountName?: string;
  emailAddress?: string;
}

function cachePath(startUrl: string, region: string): string {
  const key = createHash("sha256").update(`${startUrl}|${region}`).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `${key}.json`);
}

function readCachedToken(startUrl: string, region: string): string | null {
  const p = cachePath(startUrl, region);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { accessToken?: string; expiresAt?: string };
    if (data.accessToken && data.expiresAt && Date.parse(data.expiresAt) > Date.now() + 60_000) {
      return data.accessToken;
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

function writeCachedToken(startUrl: string, region: string, accessToken: string, expiresInSec: number): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  writeFileSync(cachePath(startUrl, region), JSON.stringify({ accessToken, expiresAt }), { mode: 0o600 });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Non-fatal: the user can copy the URL from the console.
  }
}

// Perform the device-authorization flow and return a bearer access token.
export async function login(startUrl: string, region: string): Promise<string> {
  const cached = readCachedToken(startUrl, region);
  if (cached) {
    log.ok("Reusing cached SSO session.");
    return cached;
  }

  const oidc = new SSOOIDCClient({ region });
  const reg = await oidc.send(new RegisterClientCommand({
    clientName: "bedrock-quota-increase",
    clientType: "public",
    scopes: ["sso:account:access"],
  }));

  const auth = await oidc.send(new StartDeviceAuthorizationCommand({
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    startUrl,
  }));

  log.plain("");
  log.plain(c.bold("Sign in to AWS to authorize this device."));
  log.plain(`  Verification URL: ${c.cyan(auth.verificationUriComplete)}`);
  log.plain(`  Confirm this code is shown: ${c.bold(auth.userCode)}`);
  log.plain("");
  openBrowser(auth.verificationUriComplete!);

  const interval = (auth.interval || 5) * 1000;
  const deadline = Date.now() + (auth.expiresIn || 600) * 1000;
  log.step("Waiting for you to approve in the browser…");

  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      const token = await oidc.send(new CreateTokenCommand({
        clientId: reg.clientId,
        clientSecret: reg.clientSecret,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: auth.deviceCode,
      }));
      writeCachedToken(startUrl, region, token.accessToken!, token.expiresIn || 3600);
      log.ok("SSO login complete.");
      return token.accessToken!;
    } catch (e: any) {
      const name = e?.name || e?.__type || "";
      if (name.includes("AuthorizationPendingException")) continue;
      if (name.includes("SlowDownException")) { await sleep(interval); continue; }
      throw e;
    }
  }
  throw new Error("Timed out waiting for SSO authorization.");
}

// List every account the signed-in user can reach.
export async function listAccounts(accessToken: string, region: string): Promise<SsoAccount[]> {
  const sso = new SSOClient({ region });
  const accounts: SsoAccount[] = [];
  let nextToken: string | undefined;
  do {
    const res = await sso.send(new ListAccountsCommand({ accessToken, nextToken }));
    for (const a of res.accountList || []) {
      accounts.push({ accountId: a.accountId!, accountName: a.accountName, emailAddress: a.emailAddress });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return accounts;
}

// Resolve temporary credentials for a specific account, picking a role. If
// `preferredRole` is set we use it; otherwise we use the account's first role.
export async function getAccountCredentials(
  accessToken: string,
  region: string,
  accountId: string,
  preferredRole?: string,
): Promise<AccountCredentials> {
  const sso = new SSOClient({ region });
  let roleName = preferredRole;

  if (!roleName) {
    const roles: string[] = [];
    let nextToken: string | undefined;
    do {
      const res = await sso.send(new ListAccountRolesCommand({ accessToken, accountId, nextToken }));
      for (const r of res.roleList || []) if (r.roleName) roles.push(r.roleName);
      nextToken = res.nextToken;
    } while (nextToken);
    if (roles.length === 0) throw new Error(`No roles available in account ${accountId}.`);
    roleName = roles[0]!;
  }

  const res = await sso.send(new GetRoleCredentialsCommand({ accessToken, accountId, roleName }));
  const rc = res.roleCredentials!;
  return {
    roleName,
    credentials: {
      accessKeyId: rc.accessKeyId!,
      secretAccessKey: rc.secretAccessKey!,
      sessionToken: rc.sessionToken!,
      expiration: rc.expiration ? new Date(rc.expiration) : undefined,
    },
  };
}
