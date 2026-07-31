// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Thin wrapper over the AWS Support API for the operations this tool needs.
//
// NOTE: The AWS Support API requires a Business, Enterprise On-Ramp, or
// Enterprise Support plan. It is a global service whose endpoint lives in
// us-east-1, so we always construct the client there regardless of the
// Bedrock target region.
//
// With the Service Quotas flow (quotas.ts), AWS opens the backing case itself
// for *adjustable* quotas, so most runs no longer call CreateCase at all. This
// module is used for two things now:
//   1. Opening a case directly for *non-adjustable* quotas (the fallback), with
//      the service/category codes discovered dynamically via DescribeServices.
//   2. Posting the [bqi:run=<id>] marker comment onto whichever case backs a
//      request (Service-Quotas-opened or self-opened), and reading comments back
//      so a run's cases can be rediscovered from another machine.
import {
  SupportClient,
  CreateCaseCommand,
  AddCommunicationToCaseCommand,
  ResolveCaseCommand,
  DescribeCasesCommand,
  DescribeServicesCommand,
  DescribeCommunicationsCommand,
  type CaseDetails,
} from "@aws-sdk/client-support";
import type { AwsCredentials } from "./sso.js";
import type { CaseState } from "./manifest.js";

const SUPPORT_ENDPOINT_REGION = "us-east-1";

// Fallback codes for opening a case directly (non-adjustable quota). These
// mirror a real Bedrock quota case: it appears as "Service Limit Increase,
// Bedrock" with severity "Business impairing question". The category code is
// discovered at runtime (findBedrockLimitCategory) when possible, since AWS
// adds/renames categories over time; this is the default if discovery fails.
const SERVICE_CODE = "service-limit-increase";
const DEFAULT_CATEGORY_CODE = "service-code-bedrock";
// severityCode is always one of low|normal|high|urgent|critical. For a Bedrock
// service-limit case, `high` renders as "Business impairing question" in the
// console (the console name differs from the API code).
const SEVERITY_CODE = "high";

export function supportClient(credentials: AwsCredentials): SupportClient {
  return new SupportClient({ region: SUPPORT_ENDPOINT_REGION, credentials });
}

// The internal AWS Support case id (what every Support API call requires) looks
// like `case-<12-digit-account>-<...>`. Service Quotas, however, reports the
// backing case by its short *numeric display id* (e.g. "178536135800921" — the
// number shown in the console URL). Passing that display id to ResolveCase /
// AddCommunicationToCase / DescribeCommunications fails validation, so translate
// it to the internal id via DescribeCases(displayId) first. Anything already in
// `case-…` form (e.g. cases this tool opened itself) is passed through unchanged.
const INTERNAL_CASE_ID_RE = /^case-\d{12}-/;

export async function toSupportCaseId(client: SupportClient, caseIdOrDisplayId: string): Promise<string> {
  if (INTERNAL_CASE_ID_RE.test(caseIdOrDisplayId)) return caseIdOrDisplayId;
  const res = await client.send(new DescribeCasesCommand({
    displayId: caseIdOrDisplayId,
    includeResolvedCases: true,
    includeCommunications: false,
  }));
  return res.cases?.[0]?.caseId || caseIdOrDisplayId;
}

// Discover the Bedrock category code under the service-limit-increase service.
// AWS defines each service's own category set (and changes it over time), so we
// look it up rather than trust a hardcoded value. Returns undefined if the call
// fails or no Bedrock category is present; callers fall back to the default.
export async function findBedrockLimitCategory(client: SupportClient): Promise<string | undefined> {
  try {
    const res = await client.send(new DescribeServicesCommand({
      serviceCodeList: [SERVICE_CODE],
      language: "en",
    }));
    const categories = res.services?.[0]?.categories || [];
    const bedrock = categories.find(
      (cat) => /bedrock/i.test(cat.code || "") || /bedrock/i.test(cat.name || ""),
    );
    return bedrock?.code;
  } catch {
    return undefined;
  }
}

export interface CreateCaseInput {
  subject: string;
  body: string;
  categoryCode?: string;
  ccEmails?: string[];
}

export async function createCase(client: SupportClient, input: CreateCaseInput): Promise<string> {
  const res = await client.send(new CreateCaseCommand({
    subject: input.subject,
    serviceCode: SERVICE_CODE,
    categoryCode: input.categoryCode || DEFAULT_CATEGORY_CODE,
    severityCode: SEVERITY_CODE,
    communicationBody: input.body,
    ccEmailAddresses: input.ccEmails,
    // Only "customer-service" or "technical" are valid; a limit increase is a
    // customer-service issue.
    issueType: "customer-service",
  }));
  return res.caseId!;
}

export async function addComment(client: SupportClient, caseId: string, body: string): Promise<void> {
  const id = await toSupportCaseId(client, caseId);
  await client.send(new AddCommunicationToCaseCommand({ caseId: id, communicationBody: body }));
}

export async function resolveCase(client: SupportClient, caseId: string): Promise<void> {
  const id = await toSupportCaseId(client, caseId);
  await client.send(new ResolveCaseCommand({ caseId: id }));
}

export async function describeCase(client: SupportClient, caseId: string): Promise<CaseDetails | undefined> {
  const id = await toSupportCaseId(client, caseId);
  const res = await client.send(new DescribeCasesCommand({
    caseIdList: [id],
    includeResolvedCases: true,
    includeCommunications: false,
  }));
  return res.cases?.[0];
}

// Map a Support case `status` to the tool's case state. The Support API's case
// status tracks the case *lifecycle*, not the quota decision (it can't report
// approved/denied) — so we reduce it to just resolved vs. still-open. The API's
// finer-grained open states (e.g. work-in-progress, waiting on the customer)
// are collapsed into `pending`; users who need that detail check the support
// case directly. Used for the self-opened (non-adjustable) fallback path, and
// to corroborate the Service Quotas state.
export function caseStateFromCaseStatus(status: string | undefined): CaseState {
  switch (status) {
    case "resolved": return "resolved";
    case undefined: return "unknown";
    default: return "pending"; // any non-resolved lifecycle state
  }
}

// Whether a case's communications contain the given marker text. This is how a
// run is rediscovered when the case subject is owned by AWS (Service Quotas) and
// can't carry the marker itself — we stamp the marker into a comment instead.
export async function caseHasMarker(
  client: SupportClient,
  caseId: string,
  marker: string,
): Promise<boolean> {
  const id = await toSupportCaseId(client, caseId);
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeCommunicationsCommand({ caseId: id, nextToken }));
    for (const comm of res.communications || []) {
      if (comm.body?.includes(marker)) return true;
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return false;
}

// Find cases in the current account whose subject carries a given marker.
// Retained for cases this tool opens itself (non-adjustable fallback), whose
// subject we still control. Scans recent cases via the API's paging window.
export async function findCasesByMarker(
  client: SupportClient,
  marker: string,
): Promise<CaseDetails[]> {
  const matches: CaseDetails[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeCasesCommand({
      includeResolvedCases: true,
      includeCommunications: false,
      nextToken,
    }));
    for (const cs of res.cases || []) {
      if (cs.subject?.includes(marker)) matches.push(cs);
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return matches;
}
