// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Thin wrapper over the AWS Service Quotas API — the AWS-recommended path for
// Bedrock model-inference quota increases (RPM / TPM). For an *adjustable*
// quota, RequestServiceQuotaIncrease submits the request and AWS opens the
// backing Support case itself (returning its CaseId, sometimes only after a
// short delay). Non-adjustable quotas can't go through this API — the caller
// falls back to opening a Support case directly (see support.ts).
//
// Unlike the Support endpoint (always us-east-1), Service Quotas is a normal
// REGIONAL service: we build the client in the Bedrock target region so the
// quota we adjust is the one that applies to invocations there.
import {
  ServiceQuotasClient,
  ListServiceQuotasCommand,
  RequestServiceQuotaIncreaseCommand,
  GetRequestedServiceQuotaChangeCommand,
  ListRequestedServiceQuotaChangeHistoryCommand,
  type ServiceQuota,
  type RequestedServiceQuotaChange,
} from "@aws-sdk/client-service-quotas";
import type { AwsCredentials } from "./sso.js";
import type { BedrockModel, QuotaRequest } from "./models.js";
import type { CaseState } from "./manifest.js";

// Bedrock's Service Quotas service code (distinct from the Support serviceCode).
export const BEDROCK_SERVICE_CODE = "bedrock";

export function serviceQuotasClient(region: string, credentials: AwsCredentials): ServiceQuotasClient {
  return new ServiceQuotasClient({ region, credentials });
}

// The four quota "dimensions" this tool knows how to request, mirroring the
// QuotaRequest shape. Each maps to a distinct Service Quotas QuotaCode per
// model, discovered by fuzzy-matching the quota name.
export type QuotaDimension =
  | "requestsPerMinute"
  | "tokensPerMinute"
  | "inputTokensPerMinute"
  | "outputTokensPerMinute";

// A resolved thing-to-request: a specific Service Quotas quota plus the value
// we'll ask for. `adjustable` decides whether it goes through Service Quotas or
// falls back to a Support case.
export interface QuotaTarget {
  dimension: QuotaDimension;
  quotaCode: string;
  quotaName: string;
  desiredValue: number;
  currentValue?: number;
  adjustable: boolean;
}

// List every Bedrock quota in the region (paginated).
export async function listBedrockQuotas(client: ServiceQuotasClient): Promise<ServiceQuota[]> {
  const quotas: ServiceQuota[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListServiceQuotasCommand({
      ServiceCode: BEDROCK_SERVICE_CODE,
      MaxResults: 100,
      NextToken: nextToken,
    }));
    for (const q of res.Quotas || []) quotas.push(q);
    nextToken = res.NextToken;
  } while (nextToken);
  return quotas;
}

// Look up a single quota by its code (used when the user passes --quota-code).
export function findQuotaByCode(quotas: ServiceQuota[], quotaCode: string): ServiceQuota | undefined {
  return quotas.find((q) => q.QuotaCode === quotaCode);
}

// ── Fuzzy matching ───────────────────────────────────────────────────────────
//
// Quota names are free text that varies by model generation, e.g.
//   "Cross-region model inference tokens per minute for Anthropic Claude Opus 4.8"
//   "Global cross-region model inference requests per minute for Amazon Nova 2 Lite"
//   "[bedrock-mantle endpoint] Output tokens per minute for Claude Opus 4.8"
// There is no stable id-to-quota mapping, so we score candidate names against
// the chosen model and the requested dimension, then let the user confirm.

// Noise words that appear in nearly every label/quota name (provider, scope,
// and structural words). Dropped from both sides of the comparison so the
// model *family* ("sonnet"/"opus"/"haiku") and *version* ("5"/"4.8") are what
// actually discriminate — otherwise a Sonnet request ties with every Opus one.
const NOISE_TOKENS = new Set([
  "the", "for", "model", "inference", "profile", "us", "global", "anthropic",
  "amazon", "v1", "v2", "claude", "cross", "region", "endpoint", "bedrock",
  "mantle", "tokens", "token", "per", "minute", "requests", "input", "output",
  "on", "demand",
]);

// Split free text into comparable tokens, normalizing version numbers so
// "4-8"/"4.8"/"4_8" all compare equal, and dropping the noise words above.
function tokenize(raw: string): string[] {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+(?:[.\-_][0-9]+)*/g) || [];
  const out: string[] = [];
  for (const t of tokens) {
    const norm = t.replace(/[\-_]/g, ".");
    if (!NOISE_TOKENS.has(norm)) out.push(norm);
  }
  return out;
}

// The discriminating tokens for a model: its label and id, de-noised.
function modelTokens(model: BedrockModel): string[] {
  return [...new Set(tokenize(`${model.label} ${model.id}`))];
}

// Does a quota name describe the given dimension? RPM vs TPM, and for TPM
// whether it's the combined, input, or output flavor.
function nameMatchesDimension(name: string, dim: QuotaDimension): boolean {
  const n = name.toLowerCase();
  const perMinute = n.includes("per minute");
  if (!perMinute) return false;
  const isRequests = n.includes("requests per minute");
  const isInput = n.includes("input tokens per minute");
  const isOutput = n.includes("output tokens per minute");
  const isTokens = n.includes("tokens per minute");
  switch (dim) {
    case "requestsPerMinute": return isRequests;
    case "inputTokensPerMinute": return isInput;
    case "outputTokensPerMinute": return isOutput;
    case "tokensPerMinute": return isTokens && !isInput && !isOutput;
  }
}

// Score how well a quota name matches the model. Higher is better; 0 means the
// model name doesn't appear at all. Prefers the inference-profile scope implied
// by the model id ("global." → Global cross-region; "us."/regional → Cross-region).
function scoreModelMatch(name: string, model: BedrockModel, tokens: string[]): number {
  const n = name.toLowerCase();
  // Compare whole tokens, not substrings: "us" must not match inside "opus",
  // and the single-char version "5" must still count.
  const nameTokens = new Set(tokenize(name));
  let score = 0;
  let matched = 0;
  for (const t of tokens) {
    if (nameTokens.has(t)) {
      matched++;
      // Version-ish tokens (contain a digit) are the most discriminating.
      score += /[0-9]/.test(t) ? 3 : 1;
    }
  }
  if (matched === 0) return 0;

  // Scope preference from the model id's regional prefix.
  const wantsGlobal = model.id.startsWith("global.");
  if (wantsGlobal && n.includes("global cross-region")) score += 2;
  else if (!wantsGlobal && n.includes("cross-region") && !n.includes("global cross-region")) score += 2;
  // Slightly deprioritize the internal "[bedrock-mantle endpoint]" preview quotas.
  if (n.includes("bedrock-mantle")) score -= 1;
  return score;
}

export interface QuotaCandidate {
  quota: ServiceQuota;
  score: number;
}

// Rank the adjustable quotas that match a dimension for a model, best first.
// Non-empty only when at least one name mentions the model.
export function rankCandidates(
  quotas: ServiceQuota[],
  model: BedrockModel,
  dim: QuotaDimension,
): QuotaCandidate[] {
  const tokens = modelTokens(model);
  const scored: QuotaCandidate[] = [];
  for (const q of quotas) {
    const name = q.QuotaName || "";
    if (!nameMatchesDimension(name, dim)) continue;
    const score = scoreModelMatch(name, model, tokens);
    if (score <= 0) continue;
    scored.push({ quota: q, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Submit an increase for one adjustable quota. Returns the change record, whose
// CaseId may be populated immediately or only after AWS opens the case.
export async function requestIncrease(
  client: ServiceQuotasClient,
  quotaCode: string,
  desiredValue: number,
): Promise<RequestedServiceQuotaChange> {
  const res = await client.send(new RequestServiceQuotaIncreaseCommand({
    ServiceCode: BEDROCK_SERVICE_CODE,
    QuotaCode: quotaCode,
    DesiredValue: desiredValue,
  }));
  return res.RequestedQuota!;
}

// Map a Service Quotas RequestStatus to the tool's case state. In practice AWS
// only ever reports CASE_OPENED / CASE_CLOSED for a Bedrock quota request (the
// approve/deny decision is NOT surfaced here — verified against live cases), so
// we collapse to open (`pending`) vs. closed (`resolved`). PENDING is treated as
// still-open; anything unmapped or absent is `unknown`.
export function caseStateFromRequestStatus(status: string | undefined): CaseState {
  switch (status) {
    case "CASE_CLOSED": return "resolved";
    case "PENDING":
    case "CASE_OPENED": return "pending";
    default: return "unknown";
  }
}

// Refresh a previously submitted request — used to pick up a CaseId that wasn't
// present at request time, and the latest Status.
export async function getRequestedChange(
  client: ServiceQuotasClient,
  requestId: string,
): Promise<RequestedServiceQuotaChange | undefined> {
  const res = await client.send(new GetRequestedServiceQuotaChangeCommand({ RequestId: requestId }));
  return res.RequestedQuota;
}

// Recent Bedrock quota-change requests in the account, newest first. Used to
// rediscover a run's cases from a machine without the local manifest: the
// returned CaseIds are then matched against the run's marker comment.
export async function listChangeHistory(
  client: ServiceQuotasClient,
): Promise<RequestedServiceQuotaChange[]> {
  const out: RequestedServiceQuotaChange[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListRequestedServiceQuotaChangeHistoryCommand({
      ServiceCode: BEDROCK_SERVICE_CODE,
      NextToken: nextToken,
    }));
    for (const r of res.RequestedQuotas || []) out.push(r);
    nextToken = res.NextToken;
  } while (nextToken);
  return out;
}

// Convenience: which dimensions the QuotaRequest actually carries a value for,
// in a stable display order.
export function requestedDimensions(quotas: QuotaRequest): { dimension: QuotaDimension; value: number }[] {
  const order: QuotaDimension[] = [
    "requestsPerMinute", "tokensPerMinute", "inputTokensPerMinute", "outputTokensPerMinute",
  ];
  const out: { dimension: QuotaDimension; value: number }[] = [];
  for (const dim of order) {
    const v = quotas[dim];
    if (v !== undefined) out.push({ dimension: dim, value: v });
  }
  return out;
}

// Human labels for the dimensions (for prompts and logs).
export const DIMENSION_LABEL: Record<QuotaDimension, string> = {
  requestsPerMinute: "Requests per minute (RPM)",
  tokensPerMinute: "Tokens per minute (TPM)",
  inputTokensPerMinute: "Input tokens per minute",
  outputTokensPerMinute: "Output tokens per minute",
};
