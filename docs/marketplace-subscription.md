# Bedrock model access & the "Marketplace subscription": how it actually works

Background on why `bqi` enables Bedrock model access by **invoking the model
once** rather than calling the control-plane agreement API. This documents what
an Amazon Bedrock foundation-model "subscription" is, how you inspect it, and how
the CLI enables (and proves) model access.

## TL;DR

- For a serverless (on-demand) Bedrock foundation model, the thing people call a
  "Marketplace subscription" is mechanically a **foundation-model agreement**
  (the acceptance of the provider's EULA). For third-party models like
  Anthropic's, the account "transacts on AWS Marketplace" and spend shows on the
  AWS Marketplace bill — but there is **no separate software fee**; you pay for
  Bedrock usage (tokens / provisioned throughput).
- Under AWS's current **simplified model access**, access to Bedrock FMs is
  **enabled by default** with the right Marketplace permissions, and the **first
  invocation** of a third-party model creates the agreement on the fly.
- It is **regional**: access/entitlement is per Bedrock region. Being able to
  invoke in `us-east-1` says nothing about `eu-central-1`.
- **`bqi` now enables access by invoking the model once** (see "How the CLI
  enables access" below), not by calling `CreateFoundationModelAgreement`. A
  successful invoke is the only thing that proves the real goal: *the account
  can actually call the model.*
- It does **not** show up in `marketplace-agreement search-agreements` for the
  account (see below).

## Why we invoke instead of checking availability

`GetFoundationModelAvailability` is a tempting proxy, but it is **not
trustworthy**: it can report `AVAILABLE` / `AUTHORIZED` for a model that cannot
actually be invoked. Observed live against a test account:

```
GetFoundationModelAvailability(anthropic.claude-3-haiku-20240307-v1:0, us-east-1)
  → agreement AVAILABLE, entitlement AVAILABLE, authorization AUTHORIZED
Converse(same model)
  → ResourceNotFoundException: "This Model is marked by provider as Legacy and
     you have not been actively using the model in the last 30 days. Please
     upgrade to an active model."
```

So availability said "yes" while the model was in fact **Legacy/EOL and
uninvocable**. Only the invocation surfaced the truth. This is the core reason
the tool migrated to an invoke-based check.

You can still use the availability API as a *diagnostic*, just don't treat it as
proof:

```bash
aws bedrock get-foundation-model-availability \
  --model-id anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --region eu-central-1
```

## Does Anthropic need a NEW agreement per model version?

**No.** One Anthropic agreement/EULA covers all Anthropic model versions in an
account; new Claude releases carry the existing EULA forward. Per AWS launch
FAQs (wording paraphrased, but consistent across multiple sources):

- Claude Sonnet 4 / Opus 4 FAQ: *"customers will not be expected to acknowledge
  or accept a new EULA. The existing Anthropic EULA will apply."*
- Claude Opus 4.6 FAQ: same language.

| Question | Answer |
|---|---|
| New EULA per model version? | **No** — one Anthropic EULA covers all versions |
| Marketplace subscription per version? | **No** — existing subscription carries forward |
| First-time-use details (`PutUseCaseForModelAccess`)? | **Once per account** — covers all Anthropic models |

Implication for the tool: a per-model agreement call is largely redundant once
the account has transacted with Anthropic once — another reason the invoke path
(which just proves the specific model works today) is a better fit than
re-accepting agreements per model.

## How the CLI enables access (`src/bedrock.ts`, post-migration)

`ensureSubscription(region, credentials, foundationModelId, opts)` runs, per
account, per region:

1. **`ListInferenceProfiles`** (region-scoped, `typeEquals: SYSTEM_DEFINED`) —
   find the inference profile that fronts the model in *this* region, by
   matching each profile's `models[].modelArn` (ends in `/<foundationModelId>`).
   Ranking: **ACTIVE regional > ACTIVE global > any match**. Returns `undefined`
   if nothing fronts the model (then we fall back to the base id).
2. **`Converse`** — send a 1-token probe prompt (`maxTokens: 5`) to the resolved
   profile id (or the base id fallback). Success → `outcome: "subscribed"` with
   `invokedVia` set to the id we used. On a fresh account this first call also
   creates the AWS Marketplace agreement as a side effect.

This is a **regional** operation (targets `--region`), unlike the AWS Support
case, which always goes through the global `us-east-1` Support endpoint.

The old flow — `GetFoundationModelAvailability` short-circuit →
`PutUseCaseForModelAccess` → `ListFoundationModelAgreementOffers` →
`CreateFoundationModelAgreement` — has been **removed**. `PutUseCaseForModelAccess`
is no longer called; if a provider ever hard-requires the form before first
invoke, that now surfaces as an AccessDenied-style failure with a clear message.

### Model-id nuance — the prefix must be ADDED, and it's region-specific

This reverses the old assumption. Invocation of most current Anthropic models
via the **base id fails**:

```
Converse(anthropic.claude-sonnet-4-5-20250929-v1:0, us-east-1)
  → ValidationException: "Invocation with on-demand throughput isn't supported.
     Retry with the ID or ARN of an inference profile that contains this model."
```

So you must invoke via an **inference-profile id**, and the regional prefix is
**not guessable**:

| Region | Regional profile prefix |
|---|---|
| us-east-1 | `us.` |
| eu-central-1 | `eu.` |
| ap-southeast-2 | **`au.`** (not `apac.` — `apac.` was rejected as invalid) |

Every region also exposes a `global.` profile. This is exactly why the code
queries `ListInferenceProfiles` and matches on the model ARN rather than
string-building a prefix. Note: `deriveFoundationModelId()` in `models.ts` still
*strips* prefixes to get the base FM id for matching; the profile prefix is then
re-resolved per region by `ListInferenceProfiles`.

⚠️ **Gotcha:** the resolver matches the FM id *exactly*. A hand-typed `--llm`
missing the version suffix (e.g. `us.anthropic.claude-sonnet-4-5-20250929`,
no `-v1:0`) derives a base id that matches no profile, silently falling through
to a base-id invoke that then fails. The catalog entries in `models.ts` are
correct; this only bites on hand-typed values.

Providers **not** sold via Marketplace need no agreement (`requiresSubscription()`
returns false): `amazon`, `meta`, `mistral`, `deepseek`, `qwen`, `openai`. The
invoke path handles them the same way — invocation is the check either way.

### Invoke error taxonomy (`categorizeInvokeError`)

Matched on substrings because the SDK surfaces these in the message, not as
distinct codes (all observed live 2026-07):

| Symptom | Meaning |
|---|---|
| "on-demand throughput isn't supported" | Used a base id / no profile found; need an inference profile |
| "marked by provider as Legacy" / EOL | Model is EOL and uninvocable — pick an active model |
| `AccessDenied` / "not authorized" | Role lacks Bedrock invoke / Marketplace perms, or access not enabled |
| `ValidationException` / "model identifier is invalid" | Wrong profile id for the region |
| `ThrottlingException` | Transient; retry |

## Why `marketplace-agreement search-agreements` does NOT show it

`search-agreements` is filter-sensitive and, for a serverless Bedrock FM,
returns nothing useful — enabling model access no longer creates a classic paid
Marketplace *purchase agreement* on the account. Lessons from poking at it:

- The caller (the account that accepted terms) is the **Acceptor**, so filter
  with `PartyType=Acceptor`.
- Only specific filter *combinations* are accepted; arbitrary ones fail with
  `ValidationException: Provided combination of filters is not supported`.
  A working combo for Acceptor is `AgreementType=PurchaseAgreement`
  (optionally `+ ResourceType` / `+ Status`). Valid `ResourceType` values:
  `AmiProduct`, `ContainerProduct`, `SaaSProduct`,
  `ProfessionalServicesProduct`, `MachineLearningProduct`.
- Even querying `MachineLearningProduct` returned **no** Anthropic Bedrock
  agreement — the Bedrock FM entitlement simply isn't surfaced here.

```bash
# Returns the account's Marketplace purchase agreements — but NOT the Bedrock
# FM entitlements. Useful only to confirm they're absent.
aws marketplace-agreement search-agreements --catalog AWSMarketplace \
  --filters '[{"name":"PartyType","values":["Acceptor"]},
              {"name":"AgreementType","values":["PurchaseAgreement"]}]' \
  --region us-east-1
```

`license-manager list-received-licenses` is another place people look, but it
requires the License Manager service-linked role to be set up; without it you
get `AccessDeniedException: Service role not found`.

## Regional entitlement is per-region and can drift

Anthropic entitlement is reported **per Bedrock region**, and the reported state
for a given account is not always stable over time — an account can report
`NONE_ENTITLED` for a region one day and `entitlement AVAILABLE` the next, with
no explicit action in between. This is consistent with the "one Anthropic
agreement covers the account" behavior above, but the exact propagation isn't
documented. Two takeaways:

- **Don't treat a single availability sweep as durable** — it's a snapshot, not
  a guarantee.
- Per-region gaps often don't matter in practice if you invoke via a
  cross-region inference profile (`global.` / regional profiles), which route to
  a geo pool.

Note also that **opt-in regions** you haven't enabled on the account return
`UnrecognizedClientException` — which is distinct from "offered but not yet
entitled".

## Identity gotcha: inspection access ≠ SSO access

The account you can *inspect* (e.g. via an admin role in the console) and the
account `bqi` can *act on* may sit behind different identity paths. An account
reachable for inspection may not be granted by the SSO org behind your
`--start-url`, in which case `bqi` fails with `No access` at
`getAccountCredentials` and creates nothing.

Takeaway: verify the `--start-url` (SSO org) actually includes the target
account before running. "I can see it in the console/CLI" ≠ "this SSO start URL
can assume a role in it."

## Caveats worth knowing

- The invoke path *auto-creating* an agreement on a genuinely fresh, never-
  entitled account rests on AWS's simplified-model-access guidance rather than a
  before/after capture in this project — accounts tested here were already
  entitled. The behavior is documented by AWS; just be aware the first-invoke
  side effect is the mechanism the tool relies on.
