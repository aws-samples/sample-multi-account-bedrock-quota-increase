# bedrock-quota-increase

Request **Amazon Bedrock model quota increases across many AWS accounts** in one
command. For each account the tool:

1. **Enables model access** by invoking the model once, so it's ready to use —
   on a fresh account that first invocation also creates the AWS Marketplace
   agreement (the Bedrock *foundation-model agreement*) as a side effect; and
2. **Submits the quota increase through the AWS Service Quotas API** — the
   AWS-recommended path. For an *adjustable* quota AWS opens the backing Support
   case itself; a *non-adjustable* quota falls back to a Support case this tool
   opens directly. Either way the backing case is stamped with a run marker —
   `[bqi:run=<id>]` — so the same run can later be **listed, commented on, or
   closed** with a single command.

> **Tip:** pair this with
> [sample-amazon-bedrock-ops-alert](https://github.com/aws-samples/sample-amazon-bedrock-ops-alert)
> — a sample that watches Bedrock usage and alerts as you approach your quotas.
> Use it to see *when* you're running out of headroom, then use this tool to
> raise the quota across your accounts.

```bash
npx github:aws-samples/sample-multi-account-bedrock-quota-increase \
  --start-url https://my-org.awsapps.com/start \
  --accounts 111111111111,222222222222,333333333333 \
  --llm global.anthropic.claude-opus-4-8 \
  --input-tpm 4000000 --output-tpm 400000 \
  --justification "#Adoption\nWe expect massive adoption of our new product"
```

You choose which quotas to raise — only the dimensions you pass a flag for
(`--rpm`, `--tpm`, `--input-tpm`, `--output-tpm`) are adjusted; at least one is
required. For a longer justification, keep it in a Markdown file and pass it
with `--body-file`:

```bash
npx github:aws-samples/sample-multi-account-bedrock-quota-increase \
  --start-url https://my-org.awsapps.com/start \
  --accounts 111111111111,222222222222 \
  --llm global.anthropic.claude-opus-4-8 \
  --rpm 500 \
  --body-file ./justification.md
```

No pre-configured AWS profiles are required. The tool runs the IAM Identity
Center (SSO) device-authorization flow itself: you pass your access-portal
start URL, approve once in the browser, and it fetches temporary credentials for
each target account.

## Choosing which accounts to target

Pick your target accounts one of three ways (at least one is required):

| Method | Flag |
|--------|------|
| Explicit account IDs | `--accounts 111111111111,222222222222` |
| An **Organizational Unit** (recursively) | `--ou ou-abcd-11111111` |
| An **account tag** filter | `--tag team=ml,env=prod` |

`--ou` and `--tag` resolve accounts through the **AWS Organizations API**, so
they need `--org-account <id>` — the organization's management account (or a
delegated administrator) that the tool calls Organizations from. `--org-role`
picks the role to assume there (defaults to `--role`, else the first available).
Only **ACTIVE** accounts are targeted.

**Select every account under an OU** (nested OUs included):

```bash
npx github:aws-samples/sample-multi-account-bedrock-quota-increase \
  --start-url https://my-org.awsapps.com/start \
  --org-account 999999999999 \
  --ou ou-abcd-11111111 \
  --llm global.anthropic.claude-opus-4-8 \
  --input-tpm 4000000 --output-tpm 400000 \
  --justification "Raising limits across the Prod OU"
```

**Pick an OU interactively** — pass `--ou` with **no value** and the tool lists
your organization's OUs (with their full path, e.g. `Root / Workloads / Prod`)
and lets you choose one with the **arrow keys** (↑/↓, Enter to select):

```bash
npx github:aws-samples/sample-multi-account-bedrock-quota-increase \
  --start-url https://my-org.awsapps.com/start \
  --org-account 999999999999 \
  --ou \
  --llm global.anthropic.claude-opus-4-8 \
  --input-tpm 4000000 --output-tpm 400000 \
  --justification "Raising limits across a chosen OU"
```

**Select accounts by tag** — every ACTIVE account carrying *all* the given
`Key=Value` tags:

```bash
npx github:aws-samples/sample-multi-account-bedrock-quota-increase \
  --start-url https://my-org.awsapps.com/start \
  --org-account 999999999999 \
  --tag team=ml,env=prod \
  --llm global.anthropic.claude-opus-4-8 \
  --input-tpm 4000000 --output-tpm 400000 \
  --justification "Raising limits for the ML team's prod accounts"
```

Combine `--ou` and `--tag` to **intersect** them — accounts that are both under
the OU *and* carry all the tags.

---

## Prerequisites

- **Node.js 18+** (`npx` ships with npm).
- An **AWS IAM Identity Center** access-portal URL (the `--start-url`), and a
  permission set / role in each target account that can call AWS Service Quotas
  (and AWS Support, for `comment`/`close` and the non-adjustable fallback).
- **Submitting the increase needs no special support plan** — Service Quotas
  requests work on any plan, and AWS opens the backing case for you.
  The **AWS Support API** (Business, Enterprise On-Ramp, or Enterprise plan) is
  only needed to `comment` on / `close` those cases from this tool, and to open
  the direct fallback case for a *non-adjustable* quota. (`--dry-run` works on
  any plan.)
- For the **model-access step**, the role assumed in each account needs Bedrock
  invoke permissions — `bedrock:InvokeModel`, `bedrock:Converse`, and
  `bedrock:ListInferenceProfiles` (e.g. `AmazonBedrockFullAccess`) — plus the
  AWS Marketplace permissions that let the first invocation create the agreement,
  and a valid payment method on the account. See
  [Skip it with `--no-subscribe`](#enabling-model-access) if your roles can't invoke.

## Enabling model access

Serverless third-party Bedrock models (e.g. Anthropic Claude) are sold through
AWS Marketplace and need a foundation-model agreement on an account before they
can be invoked. Under AWS's current **simplified model access**, that agreement
is created automatically on the model's **first invocation** — so rather than
call the agreement control-plane API, `request` proves (and enables) access by
**invoking the model once** in every target account before submitting the quota
increase:

1. `ListInferenceProfiles` — find the inference profile that fronts the model in
   `--region` (base model ids usually aren't invocable on-demand, and the
   regional prefix — `us.`, `eu.`, `au.`, … — isn't guessable, so the profile is
   resolved from Bedrock rather than string-built).
2. `Converse` — send a tiny 1-token probe. Success proves the model can be
   invoked here; on a fresh account this first call also creates the AWS
   Marketplace agreement as a side effect.

Why invoke instead of the agreement/availability APIs: the real question is *"can
this account invoke the model?"*, and only an invocation answers it.
`GetFoundationModelAvailability` can report `AVAILABLE` for a model that still
can't be invoked (e.g. a provider-Legacy/EOL model), so it isn't a trustworthy
proxy. See [docs/marketplace-subscription.md](docs/marketplace-subscription.md)
for the full rationale.

Notes:

- Model access is **regional** — it's enabled/verified in `--region` (default
  `us-east-1`), unlike the global Support endpoint.
- Models keyed to an **inference profile** (`us.…`, `global.…`) are resolved to
  their underlying foundation-model id (the regional prefix is stripped), then
  the region's fronting profile is looked up to invoke.
- Models **not sold through AWS Marketplace** (Amazon, Meta, Mistral, DeepSeek,
  Qwen, OpenAI) need no agreement; the step is reported as `skipped`.
- A successful invocation is reported as `subscribed`. (The invoke can't cheaply
  tell "just enabled" from "already had access", so there's no separate
  `already-subscribed` state on new runs.)
- Use `--no-subscribe` to only submit the quota request, or `--subscribe-only`
  to enable access without requesting an increase (e.g. when your quota is
  already sufficient).

## How the quota request works

The increase goes through the **AWS Service Quotas API**
(`RequestServiceQuotaIncrease`), which is how AWS recommends raising Bedrock
model-inference limits:

- **You choose which quotas to raise.** The tool makes no assumptions and only
  touches the dimensions you pass a flag for — `--rpm`, `--tpm`, `--input-tpm`,
  and/or `--output-tpm`. Any dimension you don't pass is left untouched. At
  least one is required for the request step.
- Bedrock quota names are per-model free text (e.g. *"Cross-region model
  inference input tokens per minute for Anthropic Claude Opus 4.8"*). For each
  requested dimension the tool **fuzzy-matches** the quota by model name and
  surfaces the best match; unless `--yes`, you then **approve or edit** the
  matched quota and value before anything is submitted. Pass
  `--quota-code L-XXXX,…` (one code per requested dimension, in order) to skip
  matching and target quotas explicitly.
- For an **adjustable** quota, AWS opens the backing Support case for you and
  returns its case id (sometimes after a short delay — `list` fills it in
  later). For a **non-adjustable** quota, the tool opens a Support case directly
  as a fallback. Every backing case gets the `[bqi:run=<id>]` marker comment.

## Commands

| Command   | What it does                                                            |
|-----------|------------------------------------------------------------------------|
| `request` | Subscribe to the model + submit tagged quota increase(s) per account *(default)* |
| `list`    | Show the requests/cases opened by a run                        |
| `comment` | Add the same comment to every case in a run                    |
| `close`   | Resolve (close) every case in a run                            |
| `runs`    | List runs recorded on this machine                             |

Run `npx github:aws-samples/sample-multi-account-bedrock-quota-increase --help` for all options.

### `request`

| Flag | Description |
|------|-------------|
| `--start-url <url>` | **Required.** AWS access-portal / SSO start URL. |
| `--accounts <ids>` | Comma-separated 12-digit account IDs. One of `--accounts` / `--ou` / `--tag` is required. |
| `--ou [ouIds]` | Comma-separated OU/root IDs; targets every ACTIVE account under them (recursively). Pass **bare `--ou`** to pick one from an interactive list. Needs `--org-account`. |
| `--tag <Key=Value,...>` | Target ACTIVE accounts carrying **all** the given tags. Needs `--org-account`. Combine with `--ou` to intersect. |
| `--org-account <id>` | Management / delegated-admin account to call AWS Organizations from. Required when `--ou`/`--tag` is used. |
| `--org-role <name>` | SSO role to assume in `--org-account`. Default: `--role`, else the first available. |
| `--llm <model-id>` | Bedrock model / inference-profile id. If omitted you get an interactive picker. |
| `--quota-code <codes>` | Explicit Service Quotas quota code(s), comma-separated (one per requested dimension, in order). Skips fuzzy matching. |
| `--justification <text>` | Business justification. `\n` becomes a real newline. |
| `--body-file <path>` | Read the justification (request) or comment text (comment) from a file (e.g. a Markdown `.md` file). Wins over `--justification`/`--body` if both are given. |
| `--role <name>` | SSO role/permission-set name to assume in each account. Default: the first role available in each account. |
| `--region <region>` | Bedrock target region referenced in the case. Default `us-east-1`. |
| `--sso-region <region>` | Region of your Identity Center instance. Default `us-east-1`. |
| `--rpm <n>` / `--tpm <n>` | Requested requests- / combined-tokens-per-minute (older models with a single TPM quota). |
| `--input-tpm <n>` / `--output-tpm <n>` | Requested input- / output-tokens-per-minute (newer models with split token quotas). |
| `--cc <emails>` | Comma-separated CC addresses on the fallback case. |
| `--no-subscribe` | Skip the model-access (invoke) step; only submit the quota request. |
| `--subscribe-only` | Only enable model access (invoke once); submit no quota request. Mutually exclusive with `--no-subscribe`. |
| `--dry-run` | Print what would happen; create nothing. Works on any support plan. |
| `--yes` | Skip the confirmation prompt (for CI / non-interactive use). |

On success the run ID is printed to **stdout** (all human logs go to stderr), so
you can capture it in a script:

```bash
RUN_ID=$(npx github:aws-samples/sample-multi-account-bedrock-quota-increase \
  --start-url "$URL" --accounts "$ACCTS" --llm "$MODEL" --tpm 6000000 --yes 2>/dev/null)
```

### Acting on a run later

Every backing case created by a run carries the `[bqi:run=<id>]` marker (in a
comment, and in the subject too for cases this tool opens itself), and a local
manifest is saved under `~/.bqi/runs/<id>.json`. Use either the run ID or the
manifest:

```bash
# See the cases (offline — last-known state from the local manifest)
npx github:aws-samples/sample-multi-account-bedrock-quota-increase list --run "$RUN_ID"

# See the cases with their live case state (pending / resolved). Adding
# --start-url logs in, queries Service Quotas + Support for each request's
# current state, and refreshes the local manifest to match — so a case AWS
# closed shows as resolved even if you never ran `close` yourself.
#
# Note: AWS does not expose the approve/deny *decision* for a Bedrock quota
# case through either API, so `list` reports only whether the backing case is
# still open (pending) or closed (resolved), not whether it was granted.
npx github:aws-samples/sample-multi-account-bedrock-quota-increase list \
  --start-url "$URL" --run "$RUN_ID"

# Add a note to every case in the run (inline, or from a file with --body-file)
npx github:aws-samples/sample-multi-account-bedrock-quota-increase comment \
  --start-url "$URL" --run "$RUN_ID" \
  --body "Following up — please prioritize, launch is next week."

# Close every case in the run
npx github:aws-samples/sample-multi-account-bedrock-quota-increase close \
  --start-url "$URL" --run "$RUN_ID" --yes
```

If you omit `--run` from `list`, `comment`, or `close`, the tool shows the runs
recorded on this machine and lets you pick one with the **arrow keys** (↑/↓,
Enter to select, Esc to cancel). `comment` and `close` list only runs with open
cases; `list` shows them all. The `runs` command prints the same list
non-interactively.

If you act from a **different machine** (no local manifest), add
`--accounts <ids>` and the tool rediscovers the run's cases by their
`[bqi:run=<id>]` marker via the Support and Service Quotas APIs.

## Adding new models

When a new model ships, add a row to [`src/models.ts`](src/models.ts) so it
appears in the interactive picker — or skip the catalog entirely and pass any
inference-profile id with `--llm`. The catalog is a convenience, not an
allow-list. A row carries no quota numbers: the quotas to raise come solely from
the `--rpm`/`--tpm`/`--input-tpm`/`--output-tpm` flags at request time.

```ts
{
  id: "us.anthropic.claude-sonnet-5",
  label: "Anthropic Claude Sonnet 5 (US inference profile)",
  // Optional: the plain foundation-model id used for the AWS Marketplace
  // subscription. If omitted, it's derived from `id` by dropping the regional
  // prefix ("us.anthropic.claude-sonnet-5" → "anthropic.claude-sonnet-5").
  foundationModelId: "anthropic.claude-sonnet-5",
},
```

For an uncatalogued `--llm`, the same derivation applies, so most inference-profile
ids subscribe correctly with no catalog entry. Provide `foundationModelId`
explicitly only when the derived id would be wrong.

---

## How to test

You don't need to create real cases to exercise almost the whole tool.

### 1. Local checkout — build and preview (no AWS calls)

```bash
git clone https://github.com/aws-samples/sample-multi-account-bedrock-quota-increase
cd sample-multi-account-bedrock-quota-increase
npm install          # also compiles TypeScript → dist/ via the prepare hook
npm run typecheck    # should print no errors

# Preview the run: arg parsing, model catalog, subject/marker generation.
# --dry-run never touches AWS, so it needs no credentials or support plan.
node dist/cli.js request --dry-run \
  --start-url https://example.awsapps.com/start \
  --accounts 111111111111,222222222222 \
  --llm global.anthropic.claude-opus-4-8 \
  --input-tpm 4000000 --output-tpm 400000 \
  --justification "#Adoption\nExpecting heavy usage"

# Interactive model picker (omit --llm):
node dist/cli.js request --dry-run \
  --start-url https://example.awsapps.com/start --accounts 111111111111 --tpm 6000000
```

Expected: a summary block, a `[bqi:run=…]` marker, and one "would request in
…" line per requested quota per account. Bad input is rejected (try a 3-digit
account id).

### 2. Test the `npx` path exactly as your customer will

Point `npx` at your fork/branch — it clones, installs, builds, and runs:

```bash
npx github:aws-samples/sample-multi-account-bedrock-quota-increase#main request --dry-run \
  --start-url https://example.awsapps.com/start --accounts 111111111111 --llm foo --tpm 6000000
```

### 3. End-to-end against a real account (creates a real case)

Use a **single test account** first. This submits a genuine quota-increase
request (and, for adjustable quotas, AWS opens a real case). `comment`/`close`
need a Business/Enterprise support plan.

```bash
# Submit one request, then immediately close its backing case.
RUN_ID=$(node dist/cli.js request \
  --start-url https://my-org.awsapps.com/start \
  --accounts 111111111111 \
  --llm global.anthropic.claude-opus-4-8 \
  --tpm 6000000 \
  --justification "Test case — please disregard" \
  --yes 2>/dev/null)

node dist/cli.js list --run "$RUN_ID"
node dist/cli.js comment --start-url https://my-org.awsapps.com/start \
  --run "$RUN_ID" --body "Test comment" --yes
node dist/cli.js close --start-url https://my-org.awsapps.com/start \
  --run "$RUN_ID" --yes
```

Verify in the [AWS Support Center](https://support.console.aws.amazon.com/support/home)
that the case was created, received the comment, and was resolved.

### What each layer touches

| Test | AWS calls | Support plan needed |
|------|-----------|---------------------|
| `--dry-run`               | none                                     | no  |
| `npm run typecheck`       | none                                     | no  |
| real `request --subscribe-only` | SSO + Bedrock invoke (Converse)    | no  |
| real `request --no-subscribe`   | SSO + Service Quotas               | no¹ |
| real `request` (default)  | SSO + Bedrock invoke + Service Quotas | no¹ |
| `comment` / `close`       | SSO + Support                            | yes |

¹ A Business/Enterprise support plan is only needed if a requested quota is
*non-adjustable* (the tool falls back to opening a Support case directly).

## Notes & limitations

- **Local state** lives in `~/.bqi/` (cached SSO token + run manifests). Deleting
  it doesn't affect any cases; runs remain rediscoverable by their `[bqi:run=<id>]`
  marker.
- The Support API endpoint is global (us-east-1); Service Quotas is regional, so
  `--region` is the region whose Bedrock quota is actually adjusted.
- Quota values are **requests**. AWS reviews each one; this tool does not itself
  grant quota.
- Accounts are processed sequentially and the manifest is written after each, so
  an interruption still leaves a usable, actionable manifest.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

If you discover a potential security issue in this project, we ask that you
notify AWS/Amazon Security via our
[vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/).
Please do **not** create a public GitHub issue.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
