// Enables (and proves) invocation of a Bedrock foundation model in an account by
// actually calling the model once, per AWS's current "simplified model access"
// guidance: access to Bedrock foundation models is enabled by default with the
// right AWS Marketplace permissions, and the FIRST invocation of a third-party
// model (e.g. Anthropic) creates the AWS Marketplace/SaaS agreement on the fly.
//
// We therefore no longer call the CreateFoundationModelAgreement control-plane
// API. Instead the flow (per account, per region) is:
//
//   1. ListInferenceProfiles  — find the inference profile that fronts the model
//                               in THIS region (base model ids are usually not
//                               invocable on-demand; a profile id/ARN is required).
//   2. Converse               — send a 1-token prompt. Success proves the model
//                               can be invoked here (and, on a fresh account,
//                               triggers agreement creation as a side effect).
//
// Why invoke instead of the agreement API: the real goal is "can this account
// invoke the model?", and only an invocation answers that. GetFoundationModel
// Availability can report AVAILABLE/AUTHORIZED for a model that still cannot be
// invoked — e.g. a provider-Legacy/EOL model — so it is not a trustworthy proxy.
//
// This is a REGIONAL operation: it targets the Bedrock region (--region), not
// the global us-east-1 Support endpoint.
//
// Models from providers not sold through AWS Marketplace (Amazon, Meta, Mistral,
// DeepSeek, Qwen, OpenAI) still need no agreement; callers skip them via
// `requiresSubscription` in models.ts. This module invokes them all the same
// when asked, since invocation is the check either way.
import {
  BedrockClient,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { AwsCredentials } from "./sso.js";

export function bedrockClient(region: string, credentials: AwsCredentials): BedrockClient {
  return new BedrockClient({ region, credentials });
}

// Outcome of attempting to enable/verify invocation for one account.
//
// NOTE: the vocabulary is kept stable for the manifest and CLI formatting.
// Under the invoke model, "subscribed" means "invocation succeeded" (access is
// present, and any needed agreement was created by the call). "already-
// subscribed" is no longer emitted — an invocation can't cheaply distinguish
// "just created" from "already had access" — but remains a valid manifest value
// for older runs. "skipped" is still decided by the caller (non-Marketplace
// providers). "failed" carries a categorized message.
export type SubscriptionOutcome =
  | "already-subscribed"
  | "subscribed"
  | "skipped"
  | "failed";

export interface SubscriptionResult {
  outcome: SubscriptionOutcome;
  // The inference-profile id/ARN we invoked (useful for logs and debugging).
  invokedVia?: string;
  error?: string;
}

// The tiny probe prompt. maxTokens is kept minimal so the check is ~free; the
// exact wording is irrelevant — we only care that Converse returns a result.
const PROBE_PROMPT = "Reply with only: ok";
const PROBE_MAX_TOKENS = 5;

// Resolve the inference-profile id to invoke for `foundationModelId` in the
// client's region. Base model ids are usually rejected for on-demand invocation
// ("Retry your request with the ID or ARN of an inference profile"), and the
// regional prefix is NOT guessable (us-east-1 → "us.", eu-central-1 → "eu.",
// ap-southeast-2 → "au." — not "apac."). So we ask Bedrock which profile fronts
// the model here rather than string-building an id.
//
// Preference order: an ACTIVE regional (non-"global.") profile, then an ACTIVE
// "global." profile, then any match. Returns undefined if no profile fronts the
// model in this region (caller then falls back to invoking the base id, which
// works for models that do support on-demand throughput).
async function resolveInferenceProfileId(
  client: BedrockClient,
  foundationModelId: string,
): Promise<string | undefined> {
  const matches: { id: string; active: boolean; regional: boolean }[] = [];

  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListInferenceProfilesCommand({
        maxResults: 100,
        typeEquals: "SYSTEM_DEFINED",
        nextToken,
      }),
    );
    for (const p of res.inferenceProfileSummaries || []) {
      const id = p.inferenceProfileId;
      if (!id) continue;
      // A profile fronts the model if any of its underlying models' ARNs end in
      // "/<foundationModelId>" (arn:aws:bedrock:…:foundation-model/<fmId>).
      const fronts = (p.models || []).some(
        (m) => (m.modelArn || "").split("/").pop() === foundationModelId,
      );
      if (!fronts) continue;
      matches.push({
        id,
        active: p.status === "ACTIVE",
        regional: !id.startsWith("global."),
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);

  if (matches.length === 0) return undefined;
  // ACTIVE regional > ACTIVE global > anything else.
  const rank = (m: { active: boolean; regional: boolean }) =>
    (m.active ? 2 : 0) + (m.regional ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a));
  return matches[0]!.id;
}

// Turn an SDK error into a short, actionable category. These strings are the
// ones observed empirically against Bedrock (2026-07); we match on substrings
// because the SDK surfaces them in the message rather than distinct codes.
function categorizeInvokeError(e: any): string {
  const name = e?.name || e?.__type || "";
  const msg = e?.message || String(e);
  if (/on-demand throughput isn.?t supported/i.test(msg)) {
    return `No inference profile found for this model in the region, and its base id is not invocable on-demand. (${msg})`;
  }
  if (/marked by provider as Legacy/i.test(msg) || /\bEOL\b/i.test(msg)) {
    return `Model is provider-Legacy/EOL and cannot be invoked. Choose an active model. (${msg})`;
  }
  if (name.includes("AccessDenied") || /access denied|not authorized/i.test(msg)) {
    return `Access denied — the role lacks Bedrock invoke/Marketplace permissions, or model access is not enabled. (${msg})`;
  }
  if (name.includes("ValidationException") || /model identifier is invalid/i.test(msg)) {
    return `Invalid model/profile id for this region. (${msg})`;
  }
  if (name.includes("ThrottlingException") || /throttl/i.test(msg)) {
    return `Throttled while probing invocation; try again. (${msg})`;
  }
  return msg;
}

// Ensure `foundationModelId` can be invoked in the client's region by actually
// invoking it once. On a fresh account this first call also creates the AWS
// Marketplace agreement for third-party models (per simplified model access).
//
// `needsUseCaseForm` is accepted for interface compatibility but no longer used:
// the invocation path submits no first-time-use form itself. If a provider ever
// hard-requires the form before first invoke, that surfaces here as an
// AccessDenied-style failure with a clear message.
export async function ensureSubscription(
  region: string,
  credentials: AwsCredentials,
  foundationModelId: string,
  _opts?: { needsUseCaseForm?: boolean },
): Promise<SubscriptionResult> {
  try {
    const control = bedrockClient(region, credentials);
    const runtime = new BedrockRuntimeClient({ region, credentials });

    // Prefer an inference profile; fall back to the base id for models that do
    // support on-demand base-id invocation (e.g. some non-Anthropic models).
    const profileId = await resolveInferenceProfileId(control, foundationModelId);
    const invokeId = profileId ?? foundationModelId;

    await runtime.send(
      new ConverseCommand({
        modelId: invokeId,
        messages: [{ role: "user", content: [{ text: PROBE_PROMPT }] }],
        inferenceConfig: { maxTokens: PROBE_MAX_TOKENS },
      }),
    );

    return { outcome: "subscribed", invokedVia: invokeId };
  } catch (e: any) {
    return { outcome: "failed", error: categorizeInvokeError(e) };
  }
}
