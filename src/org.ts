// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Thin wrapper over the AWS Organizations API for target-account selection.
//
// Lets a run choose its target accounts by Organizational Unit (--ou) or by
// account tag (--tag) instead of listing 12-digit ids by hand. Organizations
// is a global service whose endpoint lives in us-east-1, so — like the Support
// client (support.ts) — we always build it there regardless of --region.
//
// These calls must run with credentials in the organization's MANAGEMENT
// account or a delegated-admin account; the caller supplies those via
// --org-account / --org-role. Only ACTIVE accounts are returned.
import {
  OrganizationsClient,
  ListRootsCommand,
  ListOrganizationalUnitsForParentCommand,
  ListAccountsForParentCommand,
  ListAccountsCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-organizations";
import type { AwsCredentials } from "./sso.js";

const ORGANIZATIONS_ENDPOINT_REGION = "us-east-1";

export function organizationsClient(credentials: AwsCredentials): OrganizationsClient {
  return new OrganizationsClient({ region: ORGANIZATIONS_ENDPOINT_REGION, credentials });
}

// A selectable OU (or root) for the interactive `--ou` picker: its id plus a
// human-readable path like "Root / Workloads / Prod" so nested OUs are legible.
export interface OrgUnit {
  id: string;
  name: string;
  path: string;
}

// Flatten the whole organization tree into a list of roots and OUs, each with a
// hierarchical display path. Used when `--ou` is passed with no value so the
// user can arrow-key through the org's OUs. A root's id (r-…) is a valid target
// for listAccountsUnderOu, so roots are included (they select every account).
export async function listOrganizationalUnits(client: OrganizationsClient): Promise<OrgUnit[]> {
  const units: OrgUnit[] = [];

  const roots: { id: string; name: string }[] = [];
  let rootToken: string | undefined;
  do {
    const res = await client.send(new ListRootsCommand({ NextToken: rootToken }));
    for (const r of res.Roots || []) if (r.Id) roots.push({ id: r.Id, name: r.Name || "Root" });
    rootToken = res.NextToken;
  } while (rootToken);

  const walk = async (parentId: string, parentPath: string): Promise<void> => {
    let token: string | undefined;
    do {
      const res = await client.send(new ListOrganizationalUnitsForParentCommand({ ParentId: parentId, NextToken: token }));
      for (const ou of res.OrganizationalUnits || []) {
        if (!ou.Id) continue;
        const path = `${parentPath} / ${ou.Name || ou.Id}`;
        units.push({ id: ou.Id, name: ou.Name || ou.Id, path });
        await walk(ou.Id, path);
      }
      token = res.NextToken;
    } while (token);
  };

  for (const root of roots) {
    units.push({ id: root.id, name: root.name, path: root.name });
    await walk(root.id, root.name);
  }
  return units;
}

// Return the 12-digit ids of all ACTIVE accounts under an OU (or root),
// recursively descending through nested OUs. Accepts a root id (r-...) or an
// OU id (ou-...). Both the account listing and the child-OU listing paginate.
// If a `names` map is supplied, each account's human-readable name is recorded
// into it (id → name) as a side effect, for friendlier console output.
export async function listAccountsUnderOu(
  client: OrganizationsClient,
  ouId: string,
  names?: Map<string, string>,
): Promise<string[]> {
  const found = new Set<string>();

  // Direct child accounts of this parent.
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListAccountsForParentCommand({ ParentId: ouId, NextToken: nextToken }));
    for (const a of res.Accounts || []) {
      if (a.Id && a.Status === "ACTIVE") {
        found.add(a.Id);
        if (names && a.Name) names.set(a.Id, a.Name);
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  // Recurse into child OUs.
  let ouToken: string | undefined;
  do {
    const res = await client.send(new ListOrganizationalUnitsForParentCommand({ ParentId: ouId, NextToken: ouToken }));
    for (const ou of res.OrganizationalUnits || []) {
      if (ou.Id) {
        for (const id of await listAccountsUnderOu(client, ou.Id, names)) found.add(id);
      }
    }
    ouToken = res.NextToken;
  } while (ouToken);

  return [...found];
}

// Return the 12-digit ids of ACTIVE accounts that carry ALL of the given
// tag key=value pairs. Lists every account, then checks each account's tags.
export async function listAccountsByTags(
  client: OrganizationsClient,
  tags: { key: string; value: string }[],
  names?: Map<string, string>,
): Promise<string[]> {
  const accountIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
    for (const a of res.Accounts || []) {
      if (a.Id && a.Status === "ACTIVE") {
        accountIds.push(a.Id);
        if (names && a.Name) names.set(a.Id, a.Name);
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  const matched: string[] = [];
  for (const accountId of accountIds) {
    const accountTags = new Map<string, string>();
    let tagToken: string | undefined;
    do {
      const res = await client.send(new ListTagsForResourceCommand({ ResourceId: accountId, NextToken: tagToken }));
      for (const t of res.Tags || []) {
        if (t.Key !== undefined) accountTags.set(t.Key, t.Value ?? "");
      }
      tagToken = res.NextToken;
    } while (tagToken);
    if (tags.every((t) => accountTags.get(t.key) === t.value)) matched.push(accountId);
  }
  return matched;
}
