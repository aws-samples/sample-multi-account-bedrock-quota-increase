// Catalog of Amazon Bedrock models you can request quota increases for.
//
// ── HOW TO MAINTAIN ─────────────────────────────────────────────────────────
// When a new model ships, add a row here (or just run the CLI with
// `--llm <inference-profile-id>` and skip the catalog entirely). The `id` is
// the Bedrock inference-profile / model ID the customer will reference; the
// `label` is what the interactive picker shows. Keep this list short and
// current — stale rows are noise.
//
// The tool does NOT assume quota values: which quotas to raise, and to what,
// comes solely from the --rpm / --tpm / --input-tpm / --output-tpm flags. So a
// catalog row carries no default numbers.
export interface BedrockModel {
  id: string;
  label: string;
  // The plain foundation-model id used by the AWS Marketplace subscription /
  // agreement APIs (e.g. "anthropic.claude-sonnet-4-20250514-v1:0"). The quota
  // support case references `id` (which may be an inference-profile id like
  // "us.anthropic…"), but subscriptions are keyed off the underlying FM id. If
  // omitted, it's derived from `id` by dropping any regional prefix.
  foundationModelId?: string;
}

export const MODELS: BedrockModel[] = [
  {
    id: "global.anthropic.claude-opus-4-8",
    label: "Anthropic Claude Opus 4.8 (global inference profile)",
    foundationModelId: "anthropic.claude-opus-4-8",
  },
  {
    id: "us.anthropic.claude-sonnet-5",
    label: "Anthropic Claude Sonnet 5 (US inference profile)",
    foundationModelId: "anthropic.claude-sonnet-5",
  },
  {
    id: "us.anthropic.claude-haiku-4-5-20251001",
    label: "Anthropic Claude Haiku 4.5 (US inference profile)",
    foundationModelId: "anthropic.claude-haiku-4-5-20251001",
  },
  {
    id: "us.amazon.nova-pro-v1:0",
    label: "Amazon Nova Pro (US inference profile)",
    // Amazon models aren't sold via AWS Marketplace, so no subscription is needed.
    foundationModelId: "amazon.nova-pro-v1:0",
  },
];

// The quota values requested for a run — exactly the dimensions the user asked
// for via --rpm/--tpm/--input-tpm/--output-tpm, nothing implied. A field is
// present only when the corresponding flag was passed. Older models expose a
// single combined `tokensPerMinute`; newer ones split it into input/output.
export interface QuotaRequest {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  inputTokensPerMinute?: number;
  outputTokensPerMinute?: number;
}

// The requested quotas are precisely the flags the user supplied — no model
// defaults are filled in. Undefined dimensions are left untouched by the run.
export function resolveQuotas(overrides: QuotaRequest): QuotaRequest {
  return {
    requestsPerMinute: overrides.requestsPerMinute,
    tokensPerMinute: overrides.tokensPerMinute,
    inputTokensPerMinute: overrides.inputTokensPerMinute,
    outputTokensPerMinute: overrides.outputTokensPerMinute,
  };
}

export function findModel(id: string): BedrockModel | undefined {
  return MODELS.find((m) => m.id === id);
}

// If the user passes an `--llm` that isn't in the catalog we still honor it —
// the catalog is a convenience, not an allow-list.
export function resolveModel(id: string): BedrockModel {
  return findModel(id) ?? { id, label: id };
}

// ── AWS Marketplace subscription helpers ─────────────────────────────────────
//
// Regional prefixes that inference-profile ids carry in front of the plain
// foundation-model id (e.g. "us.anthropic.…", "global.anthropic.…").
const REGION_PREFIXES = new Set(["us", "eu", "apac", "global", "us-gov"]);

// Providers whose Bedrock models are NOT sold through AWS Marketplace. These
// have no product id and need no subscription/agreement — access is implicit.
// (Per the Bedrock "Request access to models" docs.)
const NON_MARKETPLACE_PROVIDERS = new Set([
  "amazon", "meta", "mistral", "deepseek", "qwen", "openai",
]);

// Drop a leading regional prefix from an inference-profile id to get the plain
// foundation-model id: "us.anthropic.claude-haiku-4-5" → "anthropic.claude-haiku-4-5".
export function deriveFoundationModelId(id: string): string {
  const dot = id.indexOf(".");
  if (dot > 0 && REGION_PREFIXES.has(id.slice(0, dot))) return id.slice(dot + 1);
  return id;
}

// The foundation-model id used for subscription APIs: explicit if set, else derived.
export function foundationModelIdFor(model: BedrockModel): string {
  return model.foundationModelId ?? deriveFoundationModelId(model.id);
}

// The provider portion of a foundation-model id ("anthropic", "amazon", …).
export function providerOf(foundationModelId: string): string {
  return foundationModelId.split(".")[0] ?? "";
}

// Whether this model needs an AWS Marketplace subscription/agreement before use.
export function requiresSubscription(model: BedrockModel): boolean {
  return !NON_MARKETPLACE_PROVIDERS.has(providerOf(foundationModelIdFor(model)));
}

// Anthropic models additionally require a one-time first-time-use (FTU) form
// submitted per account before an agreement can be created.
export function isAnthropicModel(model: BedrockModel): boolean {
  return providerOf(foundationModelIdFor(model)) === "anthropic";
}
