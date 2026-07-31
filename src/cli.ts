#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// bedrock-quota-increase (bqi)
//
// Fan out Amazon Bedrock model quota-increase requests across many AWS accounts.
// For each account it submits the increase through the AWS Service Quotas API
// (the AWS-recommended path); for adjustable quotas AWS opens the backing
// Support case itself. Every backing case is stamped with a [bqi:run=<id>]
// marker comment so a run can later be listed, commented on, or resolved.
//
// Commands:
//   request   Submit quota increases in each target account            (default)
//   list      Show the requests/cases opened by a run
//   comment   Add the same comment to every case in a run
//   close     Resolve (close) every case in a run
//   runs      List known runs on this machine
//
// See README.md for full usage and testing instructions.
import { readFileSync } from "node:fs";
import { flagStr, flagBool, flagInt, flagList, flagTags, parseArgs } from "./args.js";
import { log, c, out, fail, confirm, selectArrow, askNumber } from "./ui.js";
import {
  MODELS, resolveModel, resolveQuotas, foundationModelIdFor, requiresSubscription, isAnthropicModel,
  type BedrockModel, type QuotaRequest,
} from "./models.js";
import { login, getAccountCredentials, type AccountCredentials } from "./sso.js";
import { organizationsClient, listAccountsUnderOu, listAccountsByTags, listOrganizationalUnits } from "./org.js";
import {
  supportClient, createCase, addComment, resolveCase, findCasesByMarker,
  caseHasMarker, findBedrockLimitCategory, toSupportCaseId,
  describeCase, caseStateFromCaseStatus,
} from "./support.js";
import { ensureSubscription, type SubscriptionResult } from "./bedrock.js";
import {
  buildSubject, buildBody, buildMarkerComment, buildCrossReferenceComment,
  type CrossReferenceCase,
} from "./caseBody.js";
import {
  serviceQuotasClient, listBedrockQuotas, findQuotaByCode, rankCandidates,
  requestIncrease, getRequestedChange, listChangeHistory, requestedDimensions,
  caseStateFromRequestStatus,
  DIMENSION_LABEL, type QuotaTarget, type QuotaDimension,
} from "./quotas.js";
import {
  newRunId, markerFor, saveManifest, loadManifest, listRuns, caseBreakdown,
  manifestCases, mergeCaseStates,
  type RunManifest, type CaseRecord, type CaseBreakdown,
  type QuotaRequestRecord, type CaseState,
} from "./manifest.js";
import type { ServiceQuota } from "@aws-sdk/client-service-quotas";

// How users actually invoke the tool. It runs via `npx github:...` with no
// install, so there is no `bqi` command on their PATH — always show the full
// npx form in user-facing hints.
const INVOKE = "npx github:aws-samples/sample-multi-account-bedrock-quota-increase";

const HELP = `${c.bold("bedrock-quota-increase")} — request Bedrock quota increases across accounts

${c.bold("USAGE")}
  npx github:aws-samples/sample-multi-account-bedrock-quota-increase [command] [options]

${c.bold("COMMANDS")}
  request   Subscribe to the model + submit quota increases per account   ${c.dim("(default)")}
  list      Show the requests/cases opened by a run ${c.dim("(add --start-url for live pending/resolved status)")}
  comment   Add a comment to every case in a run
  close     Resolve (close) every case in a run
  runs      List runs recorded on this machine

${c.bold("REQUEST OPTIONS")}
  --start-url <url>       AWS access portal / SSO start URL (required)
  ${c.dim("Choose target accounts with one of --accounts / --ou / --tag (at least one required):")}
  --accounts <ids>        Comma-separated account IDs to target
  --ou [ouIds]            Comma-separated OU/root IDs; targets every ACTIVE account
                          under them (recursively). Pass bare --ou to pick one from
                          an interactive list. Requires --org-account.
  --tag <Key=Value,...>   Target ACTIVE accounts carrying ALL the given tags.
                          Requires --org-account. ${c.dim("(--ou + --tag = intersection)")}
  --org-account <id>      Management/delegated-admin account to call Organizations from
                          ${c.dim("(required when --ou/--tag is used)")}
  --org-role <name>       SSO role to assume in --org-account ${c.dim("(default: --role, else first available)")}
  --llm <model-id>        Bedrock model / inference-profile id (interactive picker if omitted)
  --quota-code <codes>    Explicit Service Quotas quota code(s), comma-separated
                          ${c.dim("(skips fuzzy matching; e.g. L-1234ABCD)")}
  --justification <text>  Business justification (used on the marker comment / fallback case)
  --body-file <path>      Read the justification/comment from a file (e.g. a .md file)
  --role <name>           SSO role to assume in each account (default: first available)
  --region <region>       Bedrock target region        ${c.dim("(default: us-east-1)")}
  --sso-region <region>   Region of the SSO instance    ${c.dim("(default: us-east-1)")}
  --rpm <n>               Requested requests-per-minute
  --tpm <n>               Requested combined tokens-per-minute (older models with a single TPM quota)
  --input-tpm <n>         Requested input tokens-per-minute  (newer models with split quotas)
  --output-tpm <n>        Requested output tokens-per-minute (newer models with split quotas)
    ${c.dim("Pass at least one of the four above — only the quota(s) you name are adjusted.")}
  --cc <emails>           Comma-separated CC emails for the fallback case
  --no-subscribe          Skip the AWS Marketplace subscription; only submit the request
  --subscribe-only        Only create the AWS Marketplace subscription; submit no request
  --dry-run               Print what would happen without submitting anything
  --yes                   Skip confirmation prompts (uses the top-ranked quota match)

${c.bold("LIST / COMMENT / CLOSE OPTIONS")}
  --run <runId>           The run to act on (interactive picker if omitted)
  --start-url <url>       SSO start URL ${c.dim("(required for comment/close; optional for list — refreshes live case state)")}
  --body <text>           Comment text            ${c.dim("(comment command)")}
  --body-file <path>      Read the comment text from a file ${c.dim("(comment command)")}
  --role, --region, --sso-region, --yes  as above

${c.bold("EXAMPLES")}
  npx github:aws-samples/sample-multi-account-bedrock-quota-increase \\
    --start-url https://my-org.awsapps.com/start \\
    --accounts 111111111111,222222222222 \\
    --llm global.anthropic.claude-opus-4-8 \\
    --input-tpm 4000000 --output-tpm 400000 \\
    --justification "We expect massive adoption of our new product"

  npx github:aws-samples/sample-multi-account-bedrock-quota-increase close \\
    --start-url https://my-org.awsapps.com/start --run 20260728...-abc
`;

function requireFlag(value: string | undefined, name: string): string {
  if (!value) fail(`Missing required --${name}. Run with --help for usage.`);
  return value!;
}

// Resolve which run to act on: the --run flag if given, otherwise present an
// arrow-key picker over the runs recorded on this machine. When `onlyOpen` is
// set (e.g. for `close`), the picker lists only runs that still have at least
// one open case, so it doesn't get cluttered with already-resolved runs.
function resolveRunId(
  flags: Record<string, string | boolean>,
  onlyOpen = false,
): Promise<string> {
  const explicit = flagStr(flags, "run");
  if (explicit) return Promise.resolve(explicit);

  const runs = listRuns();
  if (runs.length === 0) {
    fail("No --run given and no runs are recorded on this machine. Pass --run <runId>.");
  }
  const shown = onlyOpen ? runs.filter((r) => caseBreakdown(r.cases).open > 0) : runs;
  if (shown.length === 0) {
    fail("No runs with open cases were found on this machine. Pass --run <runId> to act on a specific run anyway.");
  }
  return selectArrow("Select a run:", shown, (r) => {
    const b = caseBreakdown(r.cases);
    return `${r.runId}  ${c.dim(r.createdAt)}  ${r.llm}  ${c.dim("[")}${formatBreakdown(b)}${c.dim("]")}`;
  }).then((r) => r.runId);
}

// Resolve a chunk of text that can be supplied either inline (--<inlineFlag>) or
// from a file (--body-file, any text/markdown file). If both are given, the file
// wins and we warn. Returns "" when neither is given. Used for both the request
// justification and the comment body.
function resolveTextFlag(
  flags: Record<string, string | boolean>,
  inlineFlag: string,
): string {
  const inline = flagStr(flags, inlineFlag);
  const file = flagStr(flags, "body-file");
  if (file) {
    if (inline) log.warn(`Both --${inlineFlag} and --body-file given; using the file.`);
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch (e: any) {
      fail(`Could not read --body-file "${file}": ${e?.message || e}`);
    }
    if (!contents.trim()) fail(`--body-file "${file}" is empty.`);
    return contents;
  }
  return inline || "";
}

// ── request: quota resolution ─────────────────────────────────────────────────
//
// A resolved target plus the ranked alternatives it was chosen from, so the
// review step can offer a re-pick without re-listing/re-matching.
interface ResolvedTarget {
  target: QuotaTarget;
  alternatives: ServiceQuota[];
}

// Turn the requested (dimension → value) pairs into concrete Service Quotas
// targets. Two paths per your design:
//   • --quota-code given: use those codes verbatim (deterministic).
//   • otherwise: fuzzy-match each dimension's quota by model name.
//
// This does NOT prompt — it lists the quotas and surfaces the best match per
// dimension. Confirmation/editing happens once afterwards in reviewQuotaTargets.
// Runs ONCE per run (not per account) against the first account's region — quota
// codes are global to the service, so the same codes apply everywhere.
async function resolveQuotaTargets(
  flags: Record<string, string | boolean>,
  model: BedrockModel,
  quotas: QuotaRequest,
  region: string,
  credentials: AccountCredentials["credentials"],
): Promise<ResolvedTarget[]> {
  const sq = serviceQuotasClient(region, credentials);
  log.step(`Loading Bedrock service quotas for ${region}…`);
  const allQuotas = await listBedrockQuotas(sq);
  const wanted = requestedDimensions(quotas);
  const explicitCodes = flagList(flags, "quota-code");

  // Explicit --quota-code path: pair codes with the requested dimensions in
  // order. The user is responsible for ordering; we validate each code exists.
  if (explicitCodes.length) {
    if (explicitCodes.length !== wanted.length) {
      fail(`--quota-code has ${explicitCodes.length} code(s) but ${wanted.length} quota value(s) were requested (${wanted.map((w) => DIMENSION_LABEL[w.dimension]).join(", ")}). Provide one code per requested quota, in that order.`);
    }
    const resolved: ResolvedTarget[] = [];
    for (let i = 0; i < explicitCodes.length; i++) {
      const code = explicitCodes[i]!;
      const w = wanted[i]!;
      const q = findQuotaByCode(allQuotas, code);
      if (!q) fail(`Quota code "${code}" was not found among Bedrock quotas in ${region}.`);
      resolved.push({ target: quotaTargetFrom(q!, w.dimension, w.value), alternatives: [q!] });
    }
    return resolved;
  }

  // Fuzzy path: surface the best match per dimension (no prompt here).
  const resolved: ResolvedTarget[] = [];
  for (const w of wanted) {
    const candidates = rankCandidates(allQuotas, model, w.dimension);
    if (candidates.length === 0) {
      log.warn(`No Bedrock quota matched "${DIMENSION_LABEL[w.dimension]}" for ${model.label}. Skipping this dimension — pass --quota-code to target it explicitly.`);
      continue;
    }
    const alternatives = candidates.map((cand) => cand.quota);
    resolved.push({ target: quotaTargetFrom(alternatives[0]!, w.dimension, w.value), alternatives });
  }
  return resolved;
}

function quotaTargetFrom(q: ServiceQuota, dimension: QuotaDimension, desiredValue: number): QuotaTarget {
  return {
    dimension,
    quotaCode: q.QuotaCode!,
    quotaName: q.QuotaName || q.QuotaCode!,
    desiredValue,
    currentValue: q.Value,
    adjustable: q.Adjustable === true,
  };
}

// Reproduce this exact selection non-interactively: the --quota-code + value
// flags that pin the surfaced quotas so a later run skips fuzzy matching.
function reproduceCommand(resolved: ResolvedTarget[]): string {
  const codes = resolved.map((r) => r.target.quotaCode).join(",");
  const valueFlags = resolved.map((r) => {
    const t = r.target;
    switch (t.dimension) {
      case "requestsPerMinute": return `--rpm ${t.desiredValue}`;
      case "tokensPerMinute": return `--tpm ${t.desiredValue}`;
      case "inputTokensPerMinute": return `--input-tpm ${t.desiredValue}`;
      case "outputTokensPerMinute": return `--output-tpm ${t.desiredValue}`;
    }
  });
  return `--quota-code ${codes} ${valueFlags.join(" ")}`;
}

// Show the surfaced target quotas and let the user submit, edit, or abort.
// "Edit" walks each target: re-pick the matched quota from its ranked
// alternatives, then set the requested value (Enter keeps the current one).
// With --yes (or no TTY) it submits as-is. Mutates each target in place.
async function reviewQuotaTargets(
  resolved: ResolvedTarget[],
  accountCount: number,
  skipConfirm: boolean,
): Promise<void> {
  const printTargets = () => {
    const n = resolved.length;
    log.plain("");
    log.plain(c.bold(`Quota increase${n === 1 ? "" : "s"} to request (${n}):`));
    resolved.forEach(({ target: t }, i) => {
      const num = c.dim(`${i + 1}.`);
      const adj = t.adjustable ? c.green("adjustable") : c.yellow("not adjustable → support case");
      const current = t.currentValue !== undefined ? t.currentValue.toLocaleString("en-US") : "unknown";
      log.plain("");
      log.plain(`  ${num} ${c.bold(DIMENSION_LABEL[t.dimension])}  [${adj}]`);
      log.plain(`     quota:  ${c.cyan(t.quotaName)} ${c.dim(t.quotaCode)}`);
      log.plain(`     change: ${c.dim(current)} ${c.dim("→")} ${c.bold(c.green(t.desiredValue.toLocaleString("en-US")))}`);
    });
    log.plain("");
    log.plain(`${c.dim("Reproduce this exact selection with:")}`);
    log.plain(`  ${c.dim(reproduceCommand(resolved))}`);
    log.plain("");
  };

  printTargets();
  if (skipConfirm) return;

  while (true) {
    const choice = (await selectArrow(
      `Submit these ${resolved.length} quota increase(s) in ${accountCount} account(s)?`,
      ["submit", "edit", "abort"] as const,
      (o) => o === "submit" ? "Submit as shown"
        : o === "edit" ? "Edit the target quotas and values"
        : "Abort",
    ));
    if (choice === "submit") return;
    if (choice === "abort") fail("Aborted.", 0);

    // Edit: per dimension, optionally re-pick the quota, then set the value.
    for (const r of resolved) {
      const t = r.target;
      if (r.alternatives.length > 1) {
        const repick = await confirm(
          `${c.bold(DIMENSION_LABEL[t.dimension])}: change matched quota from ${c.cyan(t.quotaName)} ${c.dim(t.quotaCode)}?`,
          false,
        );
        if (repick) {
          const q = await selectArrow(
            `Select the quota for ${DIMENSION_LABEL[t.dimension]}:`,
            r.alternatives,
            (opt) => `${opt.QuotaName}  ${c.dim(opt.QuotaCode!)}${opt.Adjustable ? "" : c.yellow(" [not adjustable]")}`,
          );
          Object.assign(t, quotaTargetFrom(q, t.dimension, t.desiredValue));
        }
      }
      t.desiredValue = await askNumber(
        `  ${DIMENSION_LABEL[t.dimension]} value ${c.dim(`[${t.desiredValue.toLocaleString("en-US")}]`)}:`,
        t.desiredValue,
      );
    }
    printTargets();
  }
}

// Resolve the run's target accounts from exactly one selection source:
//   --accounts   explicit 12-digit ids (no AWS calls, no login required)
//   --ou / --tag resolved via the AWS Organizations API from a management or
//                delegated-admin account (--org-account); needs an SSO token
// --ou and --tag may be combined (intersection: under one of the OUs AND
// carrying all the tags). When Organizations is used we log in first and hand
// the token back so the rest of the run reuses it (never logs in twice).
async function resolveTargetAccounts(
  flags: Record<string, string | boolean>,
  startUrl: string,
  ssoRegion: string,
  role: string | undefined,
): Promise<{ accounts: string[]; names: Map<string, string>; accessToken?: string }> {
  const explicit = flagList(flags, "accounts");
  let ous = flagList(flags, "ou");
  const tags = flagTags(flags, "tag");
  // `--ou` with no value (the parser stores it as `true`) means "let me pick an
  // OU interactively"; we list the org's OUs below once the client is built.
  const ouPicker = flags["ou"] === true;

  if (!explicit.length && !ous.length && !ouPicker && !tags.length) {
    fail("No accounts selected. Choose targets with one of:\n"
      + "  --accounts <ids>        comma-separated 12-digit account IDs\n"
      + "  --ou [ouIds]            comma-separated OU/root IDs, or bare --ou to pick one (needs --org-account)\n"
      + "  --tag <Key=Value,...>   account tag filter (needs --org-account)");
  }

  // Explicit ids: no AWS calls, no login (preserves the credential-free path).
  // No Organizations lookup, so no names are available for these accounts.
  if (!ous.length && !ouPicker && !tags.length) return { accounts: explicit, names: new Map() };

  for (const t of tags) {
    if (!t.key) fail(`Invalid --tag entry "${t.value}". Use Key=Value (e.g. --tag team=ml,env=prod).`);
  }

  const orgAccount = flagStr(flags, "org-account");
  if (!orgAccount) {
    fail("--ou/--tag select accounts via AWS Organizations, so --org-account <id> is required (the management or delegated-admin account to call Organizations from).");
  }
  if (!/^\d{12}$/.test(orgAccount!)) fail(`--org-account "${orgAccount}" is not a valid 12-digit AWS account id.`);
  const orgRole = flagStr(flags, "org-role") || role;

  const accessToken = await login(startUrl, ssoRegion);

  let orgCreds: AccountCredentials["credentials"];
  try {
    ({ credentials: orgCreds } = await getAccountCredentials(accessToken, ssoRegion, orgAccount!, orgRole));
  } catch (e: any) {
    fail(`Could not get credentials for --org-account ${orgAccount} to call Organizations: ${e?.message || e}`);
  }
  const org = organizationsClient(orgCreds!);

  // Bare `--ou`: list the org's OUs and let the user arrow-key to one.
  if (ouPicker && !ous.length) {
    log.step("Listing organizational units via Organizations…");
    const units = await listOrganizationalUnits(org);
    if (!units.length) fail("No organizational units found in this organization.");
    const chosen = await selectArrow(
      "Select an OU (targets every ACTIVE account under it):",
      units,
      (u) => `${u.path}  ${c.dim(u.id)}`,
    );
    ous = [chosen.id];
    log.ok(`Selected OU ${chosen.path} ${c.dim(chosen.id)}`);
  }

  let resolved: Set<string> | undefined;
  const intersect = (ids: string[]) => {
    resolved = resolved === undefined
      ? new Set(ids)
      : new Set(ids.filter((id) => resolved!.has(id)));
  };

  // Account id → human-readable name, gathered from the Organizations listings
  // so the run header and per-account log lines can show the friendly name.
  const names = new Map<string, string>();

  if (ous.length) {
    log.step(`Resolving accounts under ${ous.length} OU(s) via Organizations…`);
    const underOus = new Set<string>();
    for (const ou of ous) {
      for (const id of await listAccountsUnderOu(org, ou, names)) underOus.add(id);
    }
    intersect([...underOus]);
  }
  if (tags.length) {
    log.step(`Resolving accounts matching ${tags.length} tag(s) via Organizations…`);
    intersect(await listAccountsByTags(org, tags, names));
  }

  const accounts = [...(resolved ?? new Set<string>())].sort();
  log.ok(`Resolved ${accounts.length} account(s) from Organizations.`);
  return { accounts, names, accessToken };
}

// ── request ────────────────────────────────────────────────────────────────
async function cmdRequest(flags: Record<string, string | boolean>): Promise<void> {
  const startUrl = requireFlag(flagStr(flags, "start-url"), "start-url");
  const region = flagStr(flags, "region") || "us-east-1";
  const ssoRegion = flagStr(flags, "sso-region") || "us-east-1";
  const role = flagStr(flags, "role");

  const { accounts, names: accountNames, accessToken: resolvedToken } =
    await resolveTargetAccounts(flags, startUrl, ssoRegion, role);
  // Format an account for logs as "id (name)" when the name is known (only the
  // --ou/--tag paths resolve names via Organizations), else just the id.
  const label = (accountId: string): string => {
    const name = accountNames.get(accountId);
    return name ? `${accountId} ${c.dim(`(${name})`)}` : accountId;
  };
  for (const a of accounts) {
    if (!/^\d{12}$/.test(a)) fail(`"${a}" is not a valid 12-digit AWS account id.`);
  }
  if (accounts.length === 0) fail("No target accounts resolved. Adjust --accounts/--ou/--tag so at least one account is selected.");

  const justification = resolveTextFlag(flags, "justification");
  const ccEmails = flagList(flags, "cc");
  const dryRun = flagBool(flags, "dry-run");

  const subscribeOnly = flagBool(flags, "subscribe-only");
  const noSubscribe = flagBool(flags, "no-subscribe");
  if (subscribeOnly && noSubscribe) {
    fail("--subscribe-only and --no-subscribe are mutually exclusive.");
  }
  const doSubscribe = !noSubscribe;
  const doRequest = !subscribeOnly;

  // Model: explicit flag, else interactive picker.
  let modelId = flagStr(flags, "llm");
  if (!modelId) {
    const chosen = await selectArrow("Select a Bedrock model:", MODELS, (m) => `${m.label}  ${c.gray(m.id)}`);
    modelId = chosen.id;
  }
  const model = resolveModel(modelId);
  const quotas = resolveQuotas({
    requestsPerMinute: flagInt(flags, "rpm"),
    tokensPerMinute: flagInt(flags, "tpm"),
    inputTokensPerMinute: flagInt(flags, "input-tpm"),
    outputTokensPerMinute: flagInt(flags, "output-tpm"),
  });

  // We never assume quota values: the run only touches the dimensions the user
  // explicitly asked for. If the request step is enabled but no quota flag was
  // given, there's nothing to do — tell the user which flags to pass.
  if (doRequest && requestedDimensions(quotas).length === 0) {
    fail("No quota values given. Pass at least one of --rpm, --tpm, --input-tpm, or --output-tpm to choose which quota(s) to raise (only those are adjusted).");
  }

  const modelNeedsSub = requiresSubscription(model);
  const fmId = foundationModelIdFor(model);
  const runId = newRunId(Date.now());

  const actionLabel = doSubscribe && doRequest ? "subscribe + submit quota increase"
    : doSubscribe ? "subscribe only"
    : "submit quota increase only";

  log.plain("");
  log.plain(`${c.bold("Run:")}        ${runId}`);
  log.plain(`${c.bold("Model:")}      ${model.label} ${c.gray(`(${model.id})`)}`);
  if (doSubscribe) {
    log.plain(`${c.bold("Subscribe:")}  ${modelNeedsSub ? fmId : c.dim(`${fmId} (no marketplace subscription needed)`)}`);
  }
  log.plain(`${c.bold("Region:")}     ${region}`);
  log.plain(`${c.bold("Accounts:")}   ${accounts.length} → ${accounts.map(label).join(", ")}`);
  log.plain(`${c.bold("Actions:")}    ${actionLabel}`);
  if (doRequest) log.plain(`${c.bold("Marker:")}     ${markerFor(runId)}`);
  log.plain("");

  if (dryRun) {
    log.warn("Dry run — no subscriptions or quota increases will be submitted.");
    const wanted = requestedDimensions(quotas);
    const explicitCodes = flagList(flags, "quota-code");
    for (const accountId of accounts) {
      if (doSubscribe) {
        log.plain(modelNeedsSub
          ? `${c.dim("would subscribe in")} ${label(accountId)}: ${fmId} (${region})`
          : `${c.dim("would skip subscribe in")} ${label(accountId)}: ${fmId} not sold via marketplace`);
      }
      if (doRequest) {
        for (let i = 0; i < wanted.length; i++) {
          const w = wanted[i]!;
          const codeHint = explicitCodes[i] ? `code ${explicitCodes[i]}` : "fuzzy-matched quota";
          log.plain(`${c.dim("would request in")} ${label(accountId)}: ${DIMENSION_LABEL[w.dimension]} → ${w.value.toLocaleString("en-US")} ${c.dim(`(${codeHint})`)}`);
        }
        log.plain(`${c.dim("would stamp marker comment on the backing case in")} ${label(accountId)}`);
      }
    }
    if (doRequest && accounts.length >= 2) {
      log.plain(`${c.dim(`would post a cross-reference comment linking ${accounts.length} cases`)}`);
    }
    return;
  }

  // For the quota-request path, confirmation happens once at the target-review
  // gate below (after quotas are surfaced). When we're only subscribing there's
  // no review gate, so confirm here instead.
  if (!doRequest && doSubscribe && !flagBool(flags, "yes")) {
    const ok = await confirm(`Proceed with "${actionLabel}" in ${accounts.length} account(s)?`, false);
    if (!ok) fail("Aborted.", 0);
  }

  // Reuse the token obtained during Organizations resolution if we already
  // logged in there; otherwise (the plain --accounts path) log in now.
  const accessToken = resolvedToken ?? await login(startUrl, ssoRegion);

  const manifest: RunManifest = {
    runId,
    createdAt: new Date().toISOString(),
    llm: model.id,
    region,
    requestsPerMinute: quotas.requestsPerMinute,
    tokensPerMinute: quotas.tokensPerMinute,
    inputTokensPerMinute: quotas.inputTokensPerMinute,
    outputTokensPerMinute: quotas.outputTokensPerMinute,
    cases: [],
  };

  const needsUseCaseForm = isAnthropicModel(model);

  // Resolve the quota targets ONCE, up front, using the first account's creds.
  // Codes are service-global, so the same targets apply to every account, and
  // the interactive confirmation only happens once.
  let quotaTargets: QuotaTarget[] = [];
  if (doRequest) {
    let firstCreds: AccountCredentials["credentials"];
    try {
      ({ credentials: firstCreds } = await getAccountCredentials(accessToken, ssoRegion, accounts[0]!, role));
    } catch (e: any) {
      fail(`Could not get credentials for ${accounts[0]} to look up quotas: ${e?.message || e}`);
    }
    const resolved = await resolveQuotaTargets(flags, model, quotas, region, firstCreds!);
    if (resolved.length === 0) {
      fail("No quota targets resolved — nothing to request. Pass --quota-code to target quotas explicitly.");
    }
    await reviewQuotaTargets(resolved, accounts.length, flagBool(flags, "yes"));
    quotaTargets = resolved.map((r) => r.target);
  }

  for (const accountId of accounts) {
    const record: CaseRecord = {
      accountId,
      subscription: doSubscribe ? undefined : "not-attempted",
      quotaRequests: [],
    };
    // Push up front so incremental saves persist this account's latest state
    // even if the run is interrupted mid-account.
    manifest.cases.push(record);

    let credentials: AccountCredentials["credentials"] | undefined;
    try {
      ({ credentials } = await getAccountCredentials(accessToken, ssoRegion, accountId, role));
    } catch (e: any) {
      const msg = e?.message || String(e);
      record.error = msg;
      if (doSubscribe) { record.subscription = "failed"; record.subscriptionError = msg; }
      log.err(`Account ${label(accountId)}: ${msg}`);
      saveManifest(manifest);
      continue;
    }

    // Step 1: AWS Marketplace subscription (foundation-model agreement).
    if (doSubscribe) {
      if (!modelNeedsSub) {
        record.subscription = "skipped";
        log.ok(`Account ${label(accountId)}: ${c.dim(`no marketplace subscription needed for ${fmId}`)}`);
      } else {
        log.step(`Account ${label(accountId)}: verifying invocation of ${fmId} (creates the marketplace agreement if needed)…`);
        const sub: SubscriptionResult = await ensureSubscription(
          region, credentials, fmId, { needsUseCaseForm },
        );
        record.subscription = sub.outcome;
        if (sub.outcome === "failed") {
          record.subscriptionError = sub.error;
          log.err(`Account ${label(accountId)}: invocation check failed — ${sub.error}`);
        } else if (sub.outcome === "already-subscribed") {
          log.ok(`Account ${label(accountId)}: already subscribed to ${fmId}`);
        } else {
          log.ok(`Account ${label(accountId)}: invoked ${fmId} ${c.dim(`via ${sub.invokedVia}`)}`);
        }
      }
      saveManifest(manifest);
    }

    // Step 2: submit the quota increases.
    if (doRequest) {
      await submitQuotaRequests(
        accountId, label(accountId), credentials, region, model, quotas, quotaTargets, justification,
        ccEmails, runId, record, manifest,
      );
    }

    saveManifest(manifest);
  }

  // Report subscription outcomes (only meaningful when we attempted them).
  if (doSubscribe) {
    const subbed = manifest.cases.filter(
      (c2) => c2.subscription === "subscribed" || c2.subscription === "already-subscribed",
    ).length;
    const subSkipped = manifest.cases.filter((c2) => c2.subscription === "skipped").length;
    const subFailed = manifest.cases.filter((c2) => c2.subscription === "failed").length;
    log.plain("");
    log.ok(`${subbed} account(s) subscribed${subSkipped ? `, ${subSkipped} skipped` : ""}${subFailed ? `, ${c.red(String(subFailed))} failed` : ""}.`);
  }

  if (doRequest) {
    const allReqs = manifest.cases.flatMap((rec) => rec.quotaRequests || []);
    const ok = allReqs.filter((q) => q.status === "requested").length;
    const failed = allReqs.filter((q) => q.status === "failed").length;
    log.ok(`${ok} quota increase(s) submitted${failed ? `, ${c.red(String(failed))} failed` : ""}.`);
    // Final step: cross-reference every case created in this run so each one
    // links to its siblings. Best-effort — failures warn, they don't fail the run.
    await postCrossReferenceComments(manifest, model, region, accessToken, ssoRegion, role);

    const roleHint = role ? ` --role ${role}` : "";
    log.plain(`Manifest saved. Act on this run later with:`);
    log.plain(`  ${c.cyan(`${INVOKE} list  --run ${runId} --start-url ${startUrl}${roleHint}`)}`);
    log.plain(`  ${c.cyan(`${INVOKE} close --run ${runId} --start-url ${startUrl}${roleHint}`)}`);
  }
  out(runId);
}

// Submit every resolved quota target for one account: adjustable ones through
// Service Quotas (AWS opens the case), non-adjustable ones via a direct Support
// case. Either way, stamp the run marker comment on the resulting case.
async function submitQuotaRequests(
  accountId: string,
  accountLabel: string,
  credentials: AccountCredentials["credentials"],
  region: string,
  model: BedrockModel,
  quotas: QuotaRequest,
  targets: QuotaTarget[],
  justification: string,
  ccEmails: string[],
  runId: string,
  record: CaseRecord,
  manifest: RunManifest,
): Promise<void> {
  const sq = serviceQuotasClient(region, credentials);
  const support = supportClient(credentials);
  const markerComment = buildMarkerComment(runId);

  // Non-adjustable dimensions get bundled into ONE fallback support case rather
  // than one per dimension. Track whether we've opened it yet.
  let fallbackCaseId: string | undefined;
  const nonAdjustable = targets.filter((t) => !t.adjustable);

  for (const t of targets) {
    const rec: QuotaRequestRecord = {
      dimension: t.dimension,
      quotaCode: t.quotaCode,
      quotaName: t.quotaName,
      desiredValue: t.desiredValue,
      method: t.adjustable ? "service-quotas" : "support-case",
      status: "failed",
    };
    record.quotaRequests!.push(rec);

    if (t.adjustable) {
      log.step(`Account ${accountLabel}: requesting ${DIMENSION_LABEL[t.dimension]} → ${t.desiredValue.toLocaleString("en-US")} via Service Quotas…`);
      try {
        const change = await requestIncrease(sq, t.quotaCode, t.desiredValue);
        rec.requestId = change.Id;
        rec.status = "requested";
        // Service Quotas reports the case by its numeric display id; store the
        // internal `case-…` id the Support API needs so later list/comment/close
        // work directly. Falls back to the raw value if translation fails.
        if (change.CaseId) {
          // change.CaseId IS the numeric display id — keep it for building nice
          // console links in the cross-reference comment.
          rec.displayId = change.CaseId;
          try { rec.caseId = await toSupportCaseId(support, change.CaseId); }
          catch { rec.caseId = change.CaseId; }
        }
        log.ok(`Account ${accountLabel}: request ${change.Id}${rec.caseId ? ` (case ${rec.caseId})` : c.dim(" (case pending)")}`);
        // Stamp the marker on the backing case if AWS has already opened it.
        if (rec.caseId) {
          try {
            await addComment(support, rec.caseId, markerComment);
          } catch (e: any) {
            log.warn(`Account ${accountLabel}: could not stamp marker on case ${rec.caseId} — ${e?.message || e}`);
          }
        }
      } catch (e: any) {
        rec.error = e?.message || String(e);
        log.err(`Account ${accountLabel}: ${DIMENSION_LABEL[t.dimension]} — ${rec.error}`);
      }
    }
    saveManifest(manifest);
  }

  // Open (at most) one fallback case for all non-adjustable dimensions.
  if (nonAdjustable.length) {
    log.step(`Account ${accountLabel}: ${nonAdjustable.length} quota(s) not adjustable via Service Quotas — opening a support case…`);
    try {
      const categoryCode = await findBedrockLimitCategory(support);
      const caseId = await createCase(support, {
        subject: buildSubject(runId, model),
        body: buildBody({ runId, accountId, model, region, quotas, justification }),
        categoryCode,
        ccEmails: ccEmails.length ? ccEmails : undefined,
      });
      fallbackCaseId = caseId;
      // The subject already carries the marker for self-opened cases, but add
      // the comment too so rediscovery-by-comment works uniformly.
      try { await addComment(support, caseId, markerComment); } catch { /* subject still carries marker */ }
      log.ok(`Account ${accountLabel}: support case ${caseId} for non-adjustable quota(s)`);
    } catch (e: any) {
      log.err(`Account ${accountLabel}: could not open fallback support case — ${e?.message || e}`);
    }
    // Attach the fallback case id to each non-adjustable record.
    for (const rec of record.quotaRequests!) {
      if (rec.method === "support-case") {
        rec.caseId = fallbackCaseId;
        rec.status = fallbackCaseId ? "requested" : "failed";
        if (!fallbackCaseId) rec.error = "fallback support case creation failed";
      }
    }
    saveManifest(manifest);
  }
}

// Final step of a live `request`: gather every successfully-created backing case
// in the run and post a comment onto each that links to all its siblings. This
// gives each ticket a pointer to the other cases filed in the same batch. Runs
// once, after the per-account loop, so every case is known. Best-effort:
// per-case failures warn and are skipped; they never fail the run.
async function postCrossReferenceComments(
  manifest: RunManifest,
  model: BedrockModel,
  region: string,
  accessToken: string,
  ssoRegion: string,
  role: string | undefined,
): Promise<void> {
  // Collect the created cases (caseId present, status "requested"), plus the
  // legacy per-account shape, deduped by accountId:caseId (mirrors manifestCases).
  const seen = new Set<string>();
  const cases: (CrossReferenceCase & { displayId?: string })[] = [];
  const add = (accountId: string, caseId: string | undefined, displayId?: string) => {
    if (!caseId) return;
    const key = `${accountId}:${caseId}`;
    if (seen.has(key)) return;
    seen.add(key);
    cases.push({ accountId, caseId, displayId });
  };
  for (const rec of manifest.cases) {
    for (const q of rec.quotaRequests || []) {
      if (q.status === "requested") add(rec.accountId, q.caseId, q.displayId);
    }
    if (rec.status === "created") add(rec.accountId, rec.caseId); // legacy
  }

  if (cases.length < 2) {
    log.plain(c.dim(`Cross-reference skipped — only ${cases.length} case created (need 2+).`));
    return;
  }

  const blurb = buildCrossReferenceComment({ runId: manifest.runId, cases, model, region });

  let done = 0;
  for (const cs of cases) {
    try {
      const { credentials } = await getAccountCredentials(accessToken, ssoRegion, cs.accountId, role);
      await addComment(supportClient(credentials), cs.caseId, blurb);
      log.ok(`Account ${cs.accountId}: cross-referenced case ${cs.caseId}`);
      done++;
    } catch (e: any) {
      log.warn(`Account ${cs.accountId}: could not post cross-reference comment on ${cs.caseId} — ${e?.message || e}`);
    }
  }
  log.ok(`Cross-referenced ${done}/${cases.length} case(s).`);
}

// ── shared: resolve the backing cases of a run, per account ───────────────────
interface ResolvedCase { accountId: string; caseId: string; }

// Refresh any Service Quotas requests in the manifest that don't yet have a
// backing CaseId — AWS may open the case a little after the request. Fills in
// caseId (and stamps the marker) in place; returns the manifest cases to act on.
async function resolveRunCases(
  flags: Record<string, string | boolean>,
  runId: string,
  accessToken: string,
  ssoRegion: string,
  role: string | undefined,
): Promise<ResolvedCase[]> {
  const manifest = loadManifest(runId);

  if (manifest) {
    await refreshPendingCaseIds(manifest, accessToken, ssoRegion, role);
    const cases = manifestCases(manifest);
    if (cases.length) return cases;
  }

  // Fallback: no local manifest (e.g. different machine). Rediscover via the
  // marker across the accounts the user can reach — requires --accounts. Cases
  // opened by Service Quotas carry the marker in a comment; cases we opened
  // ourselves carry it in the subject too.
  const accounts = flagList(flags, "accounts");
  if (accounts.length === 0) {
    fail(`No local manifest for run ${runId}. Re-run on the original machine, or pass --accounts to rediscover cases by their [bqi:run] marker.`);
  }
  const marker = markerFor(runId);
  const found: ResolvedCase[] = [];
  for (const accountId of accounts) {
    try {
      const { credentials } = await getAccountCredentials(accessToken, ssoRegion, accountId, role);
      const support = supportClient(credentials);
      const seen = new Set<string>();

      // 1) Subject marker (cases we opened directly).
      for (const cs of await findCasesByMarker(support, marker)) {
        if (cs.caseId && !seen.has(cs.caseId)) { seen.add(cs.caseId); found.push({ accountId, caseId: cs.caseId }); }
      }
      // 2) Comment marker on cases Service Quotas opened. Scan the account's
      //    Bedrock quota-change history for candidate cases, then check comments.
      const sq = serviceQuotasClient(flagStr(flags, "region") || "us-east-1", credentials);
      for (const change of await listChangeHistory(sq)) {
        const caseId = change.CaseId;
        if (!caseId || seen.has(caseId)) continue;
        if (await caseHasMarker(support, caseId, marker)) {
          seen.add(caseId);
          found.push({ accountId, caseId });
        }
      }
    } catch (e: any) {
      log.err(`Account ${accountId}: ${e?.message || e}`);
    }
  }
  return found;
}

// For each Service-Quotas request lacking a caseId, ask Service Quotas again;
// if a case has since opened, record it and stamp the marker. Saves in place.
async function refreshPendingCaseIds(
  manifest: RunManifest,
  accessToken: string,
  ssoRegion: string,
  role: string | undefined,
): Promise<void> {
  const marker = markerFor(manifest.runId);
  let changed = false;
  for (const rec of manifest.cases) {
    const pending = (rec.quotaRequests || []).filter(
      (q) => q.method === "service-quotas" && q.requestId && !q.caseId && q.status === "requested",
    );
    if (!pending.length) continue;
    try {
      const { credentials } = await getAccountCredentials(accessToken, ssoRegion, rec.accountId, role);
      const sq = serviceQuotasClient(manifest.region, credentials);
      const support = supportClient(credentials);
      for (const q of pending) {
        const change = await getRequestedChange(sq, q.requestId!);
        if (change?.CaseId) {
          // Translate the numeric display id to the internal `case-…` id the
          // Support API requires (see toSupportCaseId); keep the display id too.
          q.displayId = change.CaseId;
          try { q.caseId = await toSupportCaseId(support, change.CaseId); }
          catch { q.caseId = change.CaseId; }
          changed = true;
          try { await addComment(support, q.caseId, buildMarkerComment(manifest.runId)); }
          catch { /* best effort */ }
          log.ok(`Account ${rec.accountId}: request ${q.requestId} now backed by case ${q.caseId}`);
        }
      }
    } catch (e: any) {
      log.warn(`Account ${rec.accountId}: could not refresh pending requests — ${e?.message || e}`);
    }
  }
  void marker;
  if (changed) saveManifest(manifest);
}

// Query AWS for the live state (pending / resolved) of each submitted request
// and reconcile it back into the manifest so the local store stays fresh: a
// case AWS has since closed gets its `resolvedAt` stamped even though this tool
// didn't run `close`. State comes from the Service Quotas RequestStatus and the
// backing Support case status; the two are merged (a closed case wins). Best
// effort — an account we can't reach leaves its requests `unknown`. Returns the
// live state per request for rendering, and saves the manifest if anything
// changed. AWS does not expose the approve/deny decision through either API, so
// open-vs-resolved is the only state we report.
async function reconcileCaseStates(
  manifest: RunManifest,
  accessToken: string,
  ssoRegion: string,
  role: string | undefined,
  now: string,
): Promise<Map<QuotaRequestRecord, CaseState>> {
  const out = new Map<QuotaRequestRecord, CaseState>();
  let changed = false;
  for (const rec of manifest.cases) {
    const reqs = (rec.quotaRequests || []).filter((q) => q.status === "requested");
    if (!reqs.length) continue;
    try {
      const { credentials } = await getAccountCredentials(accessToken, ssoRegion, rec.accountId, role);
      const sq = serviceQuotasClient(manifest.region, credentials);
      const support = supportClient(credentials);
      for (const q of reqs) {
        let state: CaseState = "unknown";
        // Service Quotas RequestStatus (adjustable path).
        if (q.requestId) {
          try {
            const change = await getRequestedChange(sq, q.requestId);
            state = mergeCaseStates(state, caseStateFromRequestStatus(change?.Status));
          } catch { /* leave as-is */ }
        }
        // Backing Support case status (authoritative for the self-opened path).
        if (q.caseId) {
          try {
            const details = await describeCase(support, q.caseId);
            state = mergeCaseStates(state, caseStateFromCaseStatus(details?.status));
          } catch { /* leave as-is */ }
        }
        out.set(q, state);
        // Keep the local manifest fresh: stamp resolvedAt when AWS has closed a
        // case we hadn't recorded as resolved (and clear a stale one if AWS
        // shows it open again, e.g. reopened).
        if (state === "resolved" && !q.resolvedAt) { q.resolvedAt = now; changed = true; }
        else if (state === "pending" && q.resolvedAt) { q.resolvedAt = undefined; changed = true; }
      }
    } catch (e: any) {
      log.warn(`Account ${rec.accountId}: could not fetch case state — ${e?.message || e}`);
    }
  }
  if (changed) saveManifest(manifest);
  return out;
}

// The live state to show for a request: what AWS reported this run, falling
// back to the manifest's own record (resolvedAt) when we didn't reach AWS.
function requestCaseState(q: QuotaRequestRecord, live: Map<QuotaRequestRecord, CaseState> | undefined): CaseState {
  const s = live?.get(q);
  if (s && s !== "unknown") return s;
  return q.resolvedAt ? "resolved" : "pending";
}

// Short colored token for a case state.
function formatCaseState(state: CaseState): string {
  switch (state) {
    case "resolved": return c.blue("resolved");
    case "pending": return c.green("pending");
    case "unknown":
    default: return c.dim("?");
  }
}

// ── list ─────────────────────────────────────────────────────────────────────
async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const runId = await resolveRunId(flags);
  const manifest = loadManifest(runId);
  if (manifest) {
    // With --start-url we log in once to (1) fill in any pending case IDs and
    // (2) reconcile each request's live AWS-side state (pending / resolved) back
    // into the manifest, so the local store stays fresh even when AWS closed a
    // case without us running `close`. Without it, `list` stays fully offline
    // and shows the last-known state recorded in the manifest.
    let liveStates: Map<QuotaRequestRecord, CaseState> | undefined;
    const startUrl = flagStr(flags, "start-url");
    if (startUrl) {
      const ssoRegion = flagStr(flags, "sso-region") || "us-east-1";
      const role = flagStr(flags, "role");
      try {
        const accessToken = await login(startUrl, ssoRegion);
        if (hasPendingCaseIds(manifest)) {
          await refreshPendingCaseIds(manifest, accessToken, ssoRegion, role);
        }
        liveStates = await reconcileCaseStates(manifest, accessToken, ssoRegion, role, new Date().toISOString());
      } catch (e: any) {
        log.warn(`Could not refresh from AWS: ${e?.message || e}`);
      }
    }

    log.plain(`${c.bold("Run")} ${runId}  ${c.dim(manifest.createdAt)}`);
    log.plain(`${c.dim("model")} ${manifest.llm}  ${c.dim("region")} ${manifest.region}`);
    for (const rec of manifest.cases) {
      const sub = formatSubscription(rec.subscription);
      if (rec.error) {
        log.plain(`  ${rec.accountId}  ${sub}  ${c.red(rec.error)}`);
        continue;
      }
      const reqs = rec.quotaRequests || [];
      if (!reqs.length && rec.status !== undefined) {
        // Legacy per-account case rendering.
        const tag = rec.status !== "created" ? c.red(rec.status)
          : rec.resolvedAt ? c.blue("resolved") : c.green("pending");
        log.plain(`  ${rec.accountId}  ${tag}  ${sub}  ${rec.caseId || ""}`);
        if (rec.caseId) out(`${rec.accountId} ${rec.caseId}`);
        continue;
      }
      log.plain(`  ${rec.accountId}  ${sub}`);
      for (const q of reqs) {
        // A single state word: submission failures/skips keep their own tag;
        // everything successfully submitted shows its case state (pending until
        // the backing case is opened, then pending/resolved from AWS).
        const state = q.status !== "requested" ? c.red(q.status)
          : !q.caseId ? c.yellow("case pending")
          : formatCaseState(requestCaseState(q, liveStates));
        const via = q.method === "service-quotas" ? c.dim("sq") : c.dim("case");
        log.plain(`      ${DIMENSION_LABEL[q.dimension]} → ${q.desiredValue.toLocaleString("en-US")}  ${state}  ${via}  ${q.caseId || q.requestId || ""}${q.error ? c.red(" " + q.error) : ""}`);
        if (q.caseId) out(`${rec.accountId} ${q.caseId}`);
      }
    }
    const breakdown = caseBreakdown(manifest.cases);
    log.plain(`  ${c.dim("—")} ${formatBreakdown(breakdown)}`);
    // AWS doesn't report the grant/refusal decision through the API, and a
    // pending case may be in review or waiting on a response from you — point
    // users at the console for anything beyond open-vs-resolved.
    if (breakdown.open > 0) {
      log.plain(`  ${c.dim("Open the backing support case in the AWS console for the decision or any pending questions.")}`);
    }
    return;
  }

  // Fall back to live discovery.
  const startUrl = requireFlag(flagStr(flags, "start-url"), "start-url");
  const ssoRegion = flagStr(flags, "sso-region") || "us-east-1";
  const role = flagStr(flags, "role");
  const accessToken = await login(startUrl, ssoRegion);
  const cases = await resolveRunCases(flags, runId, accessToken, ssoRegion, role);
  if (!cases.length) { log.warn("No cases found for this run."); return; }
  for (const cs of cases) {
    log.plain(`  ${cs.accountId}  ${cs.caseId}`);
    out(`${cs.accountId} ${cs.caseId}`);
  }
}

function hasPendingCaseIds(m: RunManifest): boolean {
  return m.cases.some((rec) =>
    (rec.quotaRequests || []).some((q) => q.method === "service-quotas" && q.requestId && !q.caseId && q.status === "requested"),
  );
}

// ── comment ───────────────────────────────────────────────────────────────────
async function cmdComment(flags: Record<string, string | boolean>): Promise<void> {
  const runId = await resolveRunId(flags, true);
  const body = resolveTextFlag(flags, "body");
  if (!body.trim()) fail("A comment body is required. Pass --body <text> or --body-file <path>.");
  const startUrl = requireFlag(flagStr(flags, "start-url"), "start-url");
  const ssoRegion = flagStr(flags, "sso-region") || "us-east-1";
  const role = flagStr(flags, "role");

  const accessToken = await login(startUrl, ssoRegion);
  const cases = await resolveRunCases(flags, runId, accessToken, ssoRegion, role);
  if (!cases.length) fail("No cases found for this run.");

  if (!flagBool(flags, "yes")) {
    const ok = await confirm(`Add a comment to ${cases.length} case(s)?`, false);
    if (!ok) fail("Aborted.", 0);
  }

  let done = 0;
  for (const cs of cases) {
    try {
      const { credentials } = await getAccountCredentials(accessToken, ssoRegion, cs.accountId, role);
      await addComment(supportClient(credentials), cs.caseId, body.replace(/\\n/g, "\n"));
      log.ok(`Account ${cs.accountId}: commented on ${cs.caseId}`);
      done++;
    } catch (e: any) {
      log.err(`Account ${cs.accountId}: ${e?.message || e}`);
    }
  }
  log.ok(`Commented on ${done}/${cases.length} case(s).`);
}

// ── close ─────────────────────────────────────────────────────────────────────
async function cmdClose(flags: Record<string, string | boolean>): Promise<void> {
  const runId = await resolveRunId(flags, true);
  const startUrl = requireFlag(flagStr(flags, "start-url"), "start-url");
  const ssoRegion = flagStr(flags, "sso-region") || "us-east-1";
  const role = flagStr(flags, "role");

  const accessToken = await login(startUrl, ssoRegion);
  const cases = await resolveRunCases(flags, runId, accessToken, ssoRegion, role);
  if (!cases.length) fail("No cases found for this run.");

  if (!flagBool(flags, "yes")) {
    const ok = await confirm(`Resolve (close) ${cases.length} case(s)?`, false);
    if (!ok) fail("Aborted.", 0);
  }

  // Reload the manifest so we can stamp resolvedAt on each case we close; this
  // keeps the open/closed breakdown accurate for `runs` and `list`.
  const manifest = loadManifest(runId);
  const nowIso = new Date().toISOString();

  let done = 0;
  for (const cs of cases) {
    try {
      const { credentials } = await getAccountCredentials(accessToken, ssoRegion, cs.accountId, role);
      await resolveCase(supportClient(credentials), cs.caseId);
      log.ok(`Account ${cs.accountId}: resolved ${cs.caseId}`);
      done++;
      if (manifest) stampResolved(manifest, cs.caseId, nowIso);
    } catch (e: any) {
      log.err(`Account ${cs.accountId}: ${e?.message || e}`);
    }
  }
  if (manifest) saveManifest(manifest);
  log.ok(`Resolved ${done}/${cases.length} case(s).`);
}

// Mark every manifest record that points at caseId as resolved (new + legacy).
function stampResolved(m: RunManifest, caseId: string, iso: string): void {
  for (const rec of m.cases) {
    for (const q of rec.quotaRequests || []) {
      if (q.caseId === caseId) q.resolvedAt = iso;
    }
    if (rec.caseId === caseId) rec.resolvedAt = iso; // legacy
  }
}

// Render a case breakdown like "1 pending · 2 resolved · 1 failed", coloring
// only the non-zero segments so the common case stays readable.
function formatBreakdown(b: CaseBreakdown): string {
  const parts = [
    `${b.open ? c.green(String(b.open)) : b.open} pending`,
    `${b.closed ? c.blue(String(b.closed)) : b.closed} resolved`,
    `${b.createFailed ? c.red(String(b.createFailed)) : b.createFailed} failed`,
  ];
  return parts.join(c.dim(" · "));
}

// Render the per-account subscription status as a short colored token.
function formatSubscription(status: CaseRecord["subscription"]): string {
  switch (status) {
    case "subscribed": return c.green("sub✓");
    case "already-subscribed": return c.green("sub=");
    case "skipped": return c.dim("sub–");
    case "failed": return c.red("sub✗");
    case "not-attempted":
    case undefined:
    default: return c.dim("sub?");
  }
}

// ── runs ──────────────────────────────────────────────────────────────────────
function cmdRuns(): void {
  const runs = listRuns();
  if (!runs.length) { log.warn("No runs recorded on this machine."); return; }
  for (const r of runs) {
    const b = caseBreakdown(r.cases);
    log.plain(`  ${c.bold(r.runId)}  ${c.dim(r.createdAt)}  ${r.llm}`);
    log.plain(`      ${formatBreakdown(b)}  ${c.dim(`(${b.total} total)`)}`);
    out(r.runId);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flagBool(flags, "help") || command === "help") { log.plain(HELP); return; }
  if (flagBool(flags, "version")) { out("1.0.0"); return; }

  switch (command) {
    case "request": await cmdRequest(flags); break;
    case "list": await cmdList(flags); break;
    case "comment": await cmdComment(flags); break;
    case "close": await cmdClose(flags); break;
    case "runs": cmdRuns(); break;
    default:
      fail(`Unknown command "${command}". Run with --help for usage.`);
  }
}

main().catch((e) => {
  fail(e?.message || String(e));
});
