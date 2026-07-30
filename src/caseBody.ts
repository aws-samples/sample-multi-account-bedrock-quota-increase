// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Builds the human-readable subject, body, and marker comment for support cases.
import { markerFor } from "./manifest.js";
import type { BedrockModel, QuotaRequest } from "./models.js";

export interface CaseContentInput {
  runId: string;
  accountId: string;
  model: BedrockModel;
  region: string;
  quotas: QuotaRequest;
  justification: string;
}

export function buildSubject(runId: string, _model: BedrockModel): string {
  // "Quota Increase: Bedrock" matches the subject AWS uses for a real Bedrock
  // service-limit case. The marker MUST stay in the subject — for cases this
  // tool opens itself, later commands find them by it.
  return `${markerFor(runId)} Quota Increase: Bedrock`;
}

// The run-tracking comment stamped onto every case (whether AWS opened it via
// Service Quotas or we opened it directly). Because Service Quotas owns the
// subject of the cases it creates, the marker can't live there — so it lives in
// this comment, and rediscovery scans case communications for it.
export function buildMarkerComment(runId: string): string {
  return [
    `${markerFor(runId)} Amazon Bedrock quota increase — bedrock-quota-increase run marker.`,
    "",
    `Run ID: ${runId}`,
    `Do not remove the ${markerFor(runId)} tag; automation uses it to reconcile,`,
    "comment on, and resolve the cases created by this run.",
  ].join("\n");
}

// The requested-quota lines for the case body, in a stable order and skipping
// any quota that doesn't apply to this model.
export function quotaLines(quotas: QuotaRequest): string[] {
  const lines: string[] = [];
  const add = (label: string, v: number | undefined) => {
    if (v !== undefined) lines.push(`  • ${label}: ${v.toLocaleString("en-US")}`);
  };
  add("Requests per minute (RPM)", quotas.requestsPerMinute);
  add("Tokens per minute (TPM)", quotas.tokensPerMinute);
  add("Input tokens per minute", quotas.inputTokensPerMinute);
  add("Output tokens per minute", quotas.outputTokensPerMinute);
  return lines;
}

// One case in a run, as needed to build a cross-reference link. displayId (the
// numeric id in the console URL) yields a clickable link; without it we fall
// back to the internal caseId as plain text.
export interface CrossReferenceCase {
  accountId: string;
  caseId: string;
  displayId?: string;
}

// Console URL for a support case, keyed off its numeric display id.
export function caseConsoleUrl(displayId: string): string {
  return `https://support.console.aws.amazon.com/support/home#/case/?displayId=${displayId}`;
}

// A plain-text blurb, posted onto every case created by a run, that points the
// reader at the sibling cases filed together in the same batch. Kept plain-text
// and in the same tone as buildBody/buildMarkerComment (Support comments render
// as plain text). Each sibling lists its account id plus a console link when a
// display id is known, or the internal case id as text otherwise.
export function buildCrossReferenceComment(input: {
  runId: string;
  cases: CrossReferenceCase[];
  model: BedrockModel;
  region: string;
}): string {
  const { runId, cases, model, region } = input;
  const lines: string[] = [
    "This support case is part of a batch of Amazon Bedrock quota-increase",
    "requests filed together by the bedrock-quota-increase tool.",
    "",
    `Run ID: ${runId}`,
    `Model / profile: ${model.id}`,
    `Region: ${region}`,
    "",
    `Related cases in this batch (${cases.length}, including this one):`,
  ];
  for (const cs of cases) {
    if (cs.displayId) {
      lines.push(`  • Account ${cs.accountId}: ${caseConsoleUrl(cs.displayId)}`);
    } else {
      lines.push(`  • Account ${cs.accountId}: case ${cs.caseId} (viewing requires signing in to that account)`);
    }
  }
  return lines.join("\n");
}

export function buildBody(input: CaseContentInput): string {
  const { runId, accountId, model, region, quotas, justification } = input;
  // \n sequences in a justification passed on the command line arrive literally;
  // turn them into real newlines so the case reads cleanly.
  const cleanJustification = justification.replace(/\\n/g, "\n").trim();

  return [
    "Amazon Bedrock model inference quota increase request",
    "",
    `Account:            ${accountId}`,
    `Model / profile:    ${model.id}`,
    `Region:             ${region}`,
    "",
    "Requested quotas:",
    ...quotaLines(quotas),
    "",
    "Business justification:",
    cleanJustification || "(none provided)",
    "",
    "---",
    `Filed by the bedrock-quota-increase tool. Run ID: ${runId}`,
    `Do not remove the ${markerFor(runId)} tag from the subject; automation uses it to`,
    "reconcile, comment on, and resolve the cases created by this run.",
  ].join("\n");
}
