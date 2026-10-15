// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// A "run manifest" records every quota-increase request opened by a single
// invocation so later commands (list / comment / close) can act on exactly that
// set.
//
// Two layers of tracking, so a run is recoverable even if the local file is
// lost:
//   1. A marker string [bqi:run=<runId>] stamped into every backing case — in a
//      comment (Service Quotas owns the case subject) and, for cases this tool
//      opens itself, the subject too. Discoverable through the AWS Support API
//      from any machine.
//   2. A local YAML manifest written under ~/.bqi/runs/ as bqi-run-<runId>.yaml
//      (overridable with --state-file). YAML + a stable per-user location means
//      every run made on this machine is discoverable from anywhere (no need to
//      cd back to where it was launched), and a customer can still hand the file
//      to a teammate to share exactly which quota increases a run requested.
//      Fast and offline for list/comment/close.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// Run manifests live under ~/.bqi/runs/ with this prefix. The prefix keeps the
// listing robust even if unrelated files land in the directory.
export const STATE_FILE_PREFIX = "bqi-run-";
const STATE_FILE_SUFFIX = ".yaml";

// Per-user directory holding every run's YAML state (sibling to the SSO token
// cache that sso.ts keeps under ~/.bqi/sso-cache/).
export const RUNS_DIR = join(homedir(), ".bqi", "runs");

export const MARKER_PREFIX = "bqi:run=";

export function markerFor(runId: string): string {
  return `[${MARKER_PREFIX}${runId}]`;
}

// Extract a runId from text (a case subject or comment body), if present.
export function runIdFromSubject(subject: string | undefined): string | null {
  if (!subject) return null;
  const m = subject.match(/\[bqi:run=([^\]]+)\]/);
  return m ? m[1]! : null;
}

// Outcome of the AWS Marketplace subscription (foundation-model agreement)
// attempt for this account. Mirrors bedrock.ts SubscriptionOutcome, plus
// "not-attempted" for runs where subscription was disabled.
export type SubscriptionStatus =
  | "already-subscribed"
  | "subscribed"
  | "skipped"
  | "failed"
  | "not-attempted";

// Which quota dimension a request targets (mirrors quotas.ts QuotaDimension).
export type QuotaDimension =
  | "requestsPerMinute"
  | "tokensPerMinute"
  | "inputTokensPerMinute"
  | "outputTokensPerMinute";

// How the increase was submitted: through Service Quotas (adjustable quota, AWS
// opens the case) or a Support case we opened directly (non-adjustable quota).
export type QuotaMethod = "service-quotas" | "support-case";

// The state of one quota-increase request.
export type QuotaRequestStatus =
  | "requested"   // successfully submitted (Service Quotas) / case created
  | "failed"      // submission failed
  | "skipped";    // not attempted

// The *AWS-side* lifecycle state of a request's backing case, distinct from
// QuotaRequestStatus (which only records what this tool did). Derived live from
// the Service Quotas RequestStatus and/or the backing Support case's status.
//
// Deliberately only two real states: AWS does NOT surface the approve/deny
// decision for a Bedrock quota case through either API — Service Quotas reports
// only CASE_OPENED / CASE_CLOSED, and the Support case status only tracks the
// case lifecycle. So the honest, reliable signal is simply whether the case is
// still open (`pending`) or has been closed (`resolved`). `unknown` means we
// couldn't reach AWS to check.
export type CaseState = "pending" | "resolved" | "unknown";

// Combine the state from two sources (Service Quotas + Support). A closed case
// is terminal, so `resolved` wins; a definite `pending` beats `unknown`.
const CASE_STATE_RANK: Record<CaseState, number> = {
  resolved: 2,
  pending: 1,
  unknown: 0,
};

export function mergeCaseStates(a: CaseState, b: CaseState): CaseState {
  return CASE_STATE_RANK[a] >= CASE_STATE_RANK[b] ? a : b;
}

// One quota-increase request within an account: what we asked for, how, and the
// Service Quotas request id / backing Support case id it produced.
export interface QuotaRequestRecord {
  dimension: QuotaDimension;
  quotaCode: string;
  quotaName: string;
  desiredValue: number;
  method: QuotaMethod;
  status: QuotaRequestStatus;
  // Service Quotas RequestId (adjustable path). Absent for the support-case path.
  requestId?: string;
  // The backing Support case id. For Service Quotas this may appear only after
  // AWS opens the case, so it can be filled in later by `list`/`comment`/`close`.
  caseId?: string;
  // The case's numeric *display* id (the number in the console URL). Service
  // Quotas reports the backing case by this id before it's translated to the
  // internal `case-…` id; captured so cross-reference links can point at the
  // console. May be absent for self-opened fallback cases (only the internal id
  // is known there).
  displayId?: string;
  // AWS access-portal deep link straight into this backing case, built from the
  // run's start-url + the SSO role + displayId (buildSsoShortcutUrl in
  // caseBody.ts, populated by cli.ts). Stored so the YAML file is a click-through
  // index of the run's cases. Absent until all three pieces are known.
  shortcutUrl?: string;
  // Set by `close` when the backing case is resolved via the API.
  resolvedAt?: string;
  error?: string;
}

export interface CaseRecord {
  accountId: string;
  accountName?: string;
  // The SSO role we assumed to reach this account. Recorded so later commands
  // can rebuild the AWS access-portal deep link to each backing case without
  // re-resolving the role. Absent on older manifests / accounts we never reached.
  roleName?: string;
  // The quota-increase requests issued for this account.
  quotaRequests?: QuotaRequestRecord[];
  // Result of ensuring the AWS Marketplace subscription for the model in this
  // account (independent of the quota requests).
  subscription?: SubscriptionStatus;
  subscriptionError?: string;
  // Account-level error (e.g. couldn't assume a role) that blocked everything.
  error?: string;

  // ── Legacy fields (pre-Service-Quotas runs) ────────────────────────────────
  // Older manifests tracked a single case per account in these fields. Kept so
  // `list`/`close` still work against runs created by earlier versions.
  caseId?: string;
  status?: "created" | "failed" | "skipped";
  resolvedAt?: string;
}

export interface CaseBreakdown {
  open: number;         // requested and not yet resolved by this tool
  closed: number;       // requested and later resolved by this tool
  createFailed: number; // never requested (e.g. submission failed)
  total: number;
}

// Flatten a run's quota requests (new schema) and legacy per-account cases into
// a single list of trackable items for breakdown/formatting.
interface TrackedItem { caseId?: string; requested: boolean; resolvedAt?: string; }

function trackedItems(cases: CaseRecord[]): TrackedItem[] {
  const items: TrackedItem[] = [];
  for (const rec of cases) {
    if (rec.quotaRequests && rec.quotaRequests.length) {
      for (const q of rec.quotaRequests) {
        items.push({ caseId: q.caseId, requested: q.status === "requested", resolvedAt: q.resolvedAt });
      }
    } else if (rec.status !== undefined) {
      // Legacy per-account case.
      items.push({ caseId: rec.caseId, requested: rec.status === "created", resolvedAt: rec.resolvedAt });
    }
  }
  return items;
}

export function caseBreakdown(cases: CaseRecord[]): CaseBreakdown {
  let open = 0, closed = 0, createFailed = 0;
  const items = trackedItems(cases);
  for (const it of items) {
    if (it.requested) {
      if (it.resolvedAt) closed++;
      else open++;
    } else {
      createFailed++;
    }
  }
  return { open, closed, createFailed, total: items.length };
}

export interface RunManifest {
  runId: string;
  createdAt: string;
  llm: string;
  region: string;
  requestsPerMinute?: number;
  // Combined token quota for older models; the split input/output quotas for
  // newer ones. Only the fields that applied to the run are recorded.
  tokensPerMinute?: number;
  inputTokensPerMinute?: number;
  outputTokensPerMinute?: number;
  cases: CaseRecord[];
}

export function newRunId(now: number): string {
  // Human-sortable + collision-resistant without needing Math.random at import.
  const iso = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.floor(now % 1e6).toString(36);
  return `${iso}-${rand}`;
}

// The default manifest path for a run: bqi-run-<runId>.yaml in `dir` (~/.bqi/runs
// unless a caller overrides it). Used whenever the user didn't pass an explicit
// --state-file.
export function defaultStatePath(runId: string, dir: string = RUNS_DIR): string {
  return `${dir.replace(/\/+$/, "")}/${STATE_FILE_PREFIX}${runId}${STATE_FILE_SUFFIX}`;
}

// Write the manifest as YAML to `file`, creating the parent directory if needed.
// The caller owns path selection (--state-file or defaultStatePath).
//
// `header`, when given, is written as a leading block of `#` comment lines (the
// ready-to-run commands to act on the run — see cli.ts). The manifest is
// re-saved after every account, so most saves omit `header`; those preserve the
// comment block already at the top of the file rather than dropping it.
export function saveManifest(m: RunManifest, file: string, header?: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const block = header
    ? header.map((l) => (l ? `# ${l}` : "#")).join("\n") + "\n\n"
    : preservedHeader(file);
  writeFileSync(file, block + stringifyYaml(m));
}

// The leading `#`-comment block (plus any blank lines within it) at the top of
// an existing manifest file, normalized to end in a single blank-line separator.
// Returns "" if the file is missing or has no comment header.
function preservedHeader(file: string): string {
  if (!existsSync(file)) return "";
  const kept: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("#") || line.trim() === "") kept.push(line);
    else break;
  }
  if (!kept.some((l) => l.startsWith("#"))) return "";
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  return kept.join("\n") + "\n\n";
}

// Read a manifest from an explicit YAML file path. Returns null if missing or
// unparseable.
export function loadManifest(file: string): RunManifest | null {
  if (!existsSync(file)) return null;
  try {
    return parseYaml(readFileSync(file, "utf8")) as RunManifest;
  } catch {
    return null;
  }
}

// Every run manifest found in `dir` (default: ~/.bqi/runs), newest first — the
// files matching bqi-run-*.yaml. This is the pool the interactive run picker and
// the `runs` command draw from.
export function listRuns(dir: string = RUNS_DIR): RunManifest[] {
  if (!existsSync(dir)) return [];
  const runs: RunManifest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(STATE_FILE_PREFIX) || !f.endsWith(STATE_FILE_SUFFIX)) continue;
    try {
      const m = parseYaml(readFileSync(`${dir.replace(/\/+$/, "")}/${f}`, "utf8")) as RunManifest;
      if (m && m.runId) runs.push(m);
    } catch {
      // skip corrupt
    }
  }
  return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Collect the distinct (accountId, caseId) pairs a run produced, from the new
// quota-request records and legacy per-account cases alike. Used by
// list/comment/close to act on each backing case exactly once.
export interface RunCase { accountId: string; caseId: string; }

export function manifestCases(m: RunManifest): RunCase[] {
  const seen = new Set<string>();
  const out: RunCase[] = [];
  const add = (accountId: string, caseId?: string) => {
    if (!caseId) return;
    const key = `${accountId}:${caseId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ accountId, caseId });
  };
  for (const rec of m.cases) {
    for (const q of rec.quotaRequests || []) add(rec.accountId, q.caseId);
    if (rec.status === "created") add(rec.accountId, rec.caseId); // legacy
  }
  return out;
}
