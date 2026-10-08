import type { VerificationReport } from "../contracts/index.js";

function text(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return " ";
    // Entities are literal text in Markdown, including inside table cells.
    return "&<>\"'|`*_[]~\\#!@".includes(character) ? `&#${code};` : character;
  }).join("");
}

/** Formats summary metadata only; evidence values remain in the JSON artifact. */
export function renderMarkdown(report: VerificationReport): string {
  return [
    `## DeployWitness: ${report.decision}`,
    "",
    `- Provider: ${text(report.provider)}`,
    `- Resource: ${text(report.resourceUuid)}`,
    `- Expected commit: ${text(report.expectedSha)}`,
    `- Run: ${text(report.runId)}`,
    `- Observed at: ${text(report.createdAt)}`,
    `- Tool version: ${text(report.toolVersion)}`,
    "",
    "| Check | Required | Status | Failure code | Evidence summary |",
    "| --- | --- | --- | --- | --- |",
    ...report.checks.map(
      (check) =>
        `| ${text(check.id)} | ${check.required ? "yes" : "no"} | ${check.status} | ${check.failureCode ?? "—"} | ${text(check.summary)} |`,
    ),
    "",
  ].join("\n");
}
