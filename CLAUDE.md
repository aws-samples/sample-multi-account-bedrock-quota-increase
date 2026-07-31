# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Internal-only notes (real account ids, SSO org, test-environment specifics)
> live in `CLAUDE.private.md`, which is gitignored and never published. See it
> for local test context; keep anything non-public out of this file.

## What this is

`bedrock-quota-increase` (bin: `bqi`) is a zero-install CLI, run via
`npx github:aws-samples/sample-multi-account-bedrock-quota-increase`, that fans out Amazon Bedrock
model quota-increase requests across many AWS accounts. Per account it (1)
ensures the AWS Marketplace subscription for the model, then (2) submits the
quota increase through the **AWS Service Quotas API** — for an *adjustable*
quota AWS opens the backing Support case itself; a *non-adjustable* quota falls
back to a Support case this tool opens directly. Every backing case is stamped
with a `[bqi:run=<id>]` marker (a comment, plus the subject for cases we open
ourselves) so a single run can later be listed, commented on, or closed.

The tool makes **no quota-value assumptions**: it only requests the dimensions
the user explicitly passes (`--rpm`, `--tpm`, `--input-tpm`, `--output-tpm`).
The request path fails if none are given. Catalog rows carry no default numbers.

## Commands

```bash
npm install          # installs deps AND compiles src/ → dist/ (prepare hook runs build)
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit; the primary correctness check
npm start -- <args>  # run from TypeScript source via ts-node/esm loader
node dist/cli.js <args>   # run the compiled CLI
```

There is **no test framework and no linter.** Verification is `npm run typecheck`
plus `--dry-run` (below). `dist/` is **git-ignored, not committed** — it is built
on demand by the `prepare` hook, which npm runs automatically on `npm install`
and on `npx github:...`, so a fresh clone/install always compiles `src/` before
the `bin` entry runs. When developing locally, **run `npm run build` after editing
`src/`** or `node dist/cli.js` will execute stale output (`npx` and the `bin`
entry both execute `dist/`, not `src/`).

### Exercising the CLI without touching AWS

`--dry-run` performs no AWS calls and needs no credentials or support plan — use
it as the main manual smoke test. (Exception: with `--ou`/`--tag`, dry-run still
logs in and makes the read-only Organizations calls to resolve accounts, since
the preview would be meaningless otherwise; only subscribe/quota writes are
suppressed. Plain `--accounts` dry-run stays fully credential-free.)

```bash
node dist/cli.js request --dry-run \
  --start-url https://example.awsapps.com/start \
  --accounts 111111111111,222222222222 \
  --llm global.anthropic.claude-opus-4-8 \
  --input-tpm 4000000 --output-tpm 400000 \
  --justification "#Adoption\nExpecting heavy usage"
```

At least one quota flag (`--rpm`/`--tpm`/`--input-tpm`/`--output-tpm`) is
required for the request path; the live run surfaces the fuzzy-matched target
quota(s) and asks the user to approve/edit before submitting.

## Architecture

Single-process, dependency-light TypeScript ESM (only the `@aws-sdk/*` clients:
support, service-quotas, sso, sso-oidc, bedrock, bedrock-runtime). `src/cli.ts`
is the orchestrator; each other file is one seam:

- **`cli.ts`** — arg dispatch and the five command handlers (`request` default,
  `list`, `comment`, `close`, `runs`). Owns the per-account sequential loop, the
  quota-target fuzzy match + approve/edit review gate, and the Service-Quotas /
  Support-fallback submission per account. Target accounts come from exactly one
  selection source: `--accounts` (explicit ids), or `--ou`/`--tag` resolved via
  AWS Organizations (`resolveTargetAccounts`); `--ou`+`--tag` intersect. The
  Organizations path needs `--org-account` (management/delegated-admin) and logs
  in first, reusing that token for the rest of the run.
- **`args.ts`** — hand-rolled argv parser. First non-flag token is the command
  (defaults to `request`). Boolean flags must be registered in `BOOLEAN_FLAGS`.
- **`sso.ts`** — runs the SSO-OIDC **device-authorization flow itself**, so users
  need no preconfigured AWS profiles — just `--start-url`. Caches the access
  token under `~/.bqi/sso-cache/` (mode 0600). `getAccountCredentials` fetches
  per-account temporary creds, defaulting to the account's first available role.
- **`quotas.ts`** — AWS Service Quotas wrapper (the primary request path).
  Lists Bedrock quotas, **fuzzy-matches** them to the model + dimension
  (`rankCandidates`), submits `RequestServiceQuotaIncrease`, and refreshes /
  rediscovers requests (`getRequestedChange`, `listChangeHistory`). Regional
  client (built in `--region`), unlike Support.
- **`org.ts`** — AWS Organizations wrapper for account selection by `--ou`
  (`listAccountsUnderOu`, recursive) or `--tag` (`listAccountsByTags`). Global
  service, client built in `us-east-1` like Support. ACTIVE accounts only.
- **`bedrock.ts`** — enables/proves model access by **invoking the model once**
  (`ListInferenceProfiles` → `Converse`), which on a fresh account creates the
  AWS Marketplace foundation-model agreement as a side effect. Does **not** call
  the agreement control-plane API. `ensureSubscription`; regional (`--region`).
- **`support.ts`** — thin AWS Support API wrapper (fallback case creation +
  comment/resolve + marker read). The Support client is **always** built in
  `us-east-1` (global endpoint) regardless of `--region`. `findBedrockLimitCategory`
  discovers the category via `DescribeServices` rather than hardcoding it.
- **`caseBody.ts`** — builds the case subject, body, and the `[bqi:run=<id>]`
  marker comment.
- **`models.ts`** — the Bedrock model catalog (`id` + `label` + optional
  `foundationModelId`; **no default quota numbers**) for the interactive picker.
  A **convenience, not an allow-list**: any `--llm <id>` not in the catalog is
  honored via `resolveModel`'s fallback.
- **`manifest.ts`** — run identity and local state; `QuotaRequestRecord` per
  requested dimension, with backward-compat for legacy per-account cases.
- **`ui.ts`** — zero-dependency color/logging + interactive prompts.

### Two invariants that hold the design together

1. **The marker is load-bearing.** `[bqi:run=<id>]` (`markerFor` in
   `manifest.ts`) must be stamped on every backing case. Because Service Quotas
   owns the subject of the cases it opens, the marker primarily lives in a
   **case comment** (`buildMarkerComment`); for cases this tool opens itself
   (non-adjustable fallback) it's in the subject too. It is how `resolveRunCases`
   rediscovers a run's cases when no local manifest exists (e.g. acting from a
   different machine, which then requires `--accounts`): subject match via
   `findCasesByMarker`, plus comment match (`caseHasMarker`) over cases surfaced
   by `listChangeHistory`. Never change the marker format without updating
   `runIdFromSubject`'s regex.

2. **Dual-layer run tracking.** A run is recorded both in the marker
   (server-side, machine-independent) and in a local JSON manifest at
   `~/.bqi/runs/<id>.json`. `list`/`comment`/`close` prefer the local manifest
   and fall back to marker-based discovery. The manifest is re-saved **after
   every account** (and after each quota within an account) in the `request`
   loop, so an interruption still leaves an actionable manifest. Service Quotas
   sometimes returns the backing `CaseId` only after a delay, so `list`/`comment`/
   `close` refresh pending requests (`refreshPendingCaseIds`) to fill it in.

### stdout vs stderr contract

Machine-readable output (run IDs, `account caseId` pairs) goes to **stdout** via
`out()`; all human logs go to **stderr** via `log.*`. This lets scripts do
`RUN_ID=$(... 2>/dev/null)`. Preserve this split when adding output.

### Conventions

- Accounts are processed **sequentially**, never in parallel — the manifest is
  written between each so partial progress survives a crash.
- No timestamps/randomness at import time: `newRunId` takes `Date.now()` as an
  argument rather than calling it internally.
- Interactive pickers (`selectArrow`, and its numbered `pick` fallback for
  non-raw-mode terminals, plus `confirm`/`askNumber`) require a TTY; in
  non-interactive contexts they either fall back to a default or `fail()`. Any
  new required interactive input needs a corresponding flag for CI use.
- **Quotas are flag-driven, never assumed.** Only dimensions passed via
  `--rpm`/`--tpm`/`--input-tpm`/`--output-tpm` are requested; the request path
  fails if none are given. Don't reintroduce model default quota values.
- The `close` and `comment` run-pickers list **only runs with open cases**
  (`resolveRunId(…, true)`) — commenting on a closed run's cases is not useful;
  `list` shows all runs.
