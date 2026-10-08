import type { CheckResult, VerificationReport } from "../contracts/index.js";

function escapeXml(value: string): string {
  // XML 1.0 excludes most controls and unpaired UTF-16 surrogates.
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
      ? character
      : "\ufffd";
  })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function durationSeconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

type JUnitOutcome = "failure" | "error" | "skipped" | "pass";

function outcomeFor(check: CheckResult): JUnitOutcome {
  if (!check.required && check.status !== "PASS") return "skipped";
  if (check.status === "FAIL" || check.status === "WARN") return "failure";
  if (
    check.status === "UNKNOWN" ||
    check.status === "UNSUPPORTED" ||
    check.status === "SKIP"
  ) {
    return "error";
  }
  return "pass";
}

function renderCheck(check: CheckResult): string {
  const attributes = `classname="${escapeXml(check.category)}" name="${escapeXml(check.id)}" time="${durationSeconds(check.durationMs)}"`;
  const outcome = outcomeFor(check);
  if (outcome === "failure") {
    const code =
      check.failureCode ??
      (check.status === "WARN"
        ? "REQUIRED_CHECK_WARNING"
        : "VERIFICATION_FAILED");
    return `    <testcase ${attributes}><failure type="${escapeXml(code)}" message="${escapeXml(check.summary)}">${escapeXml(check.summary)}</failure></testcase>`;
  }
  if (outcome === "error") {
    const code =
      check.failureCode ??
      (check.status === "UNKNOWN" || check.status === "UNSUPPORTED"
        ? check.status
        : "VERIFICATION_INCOMPLETE");
    return `    <testcase ${attributes}><error type="${escapeXml(code)}" message="${escapeXml(check.summary)}">${escapeXml(check.summary)}</error></testcase>`;
  }
  if (outcome === "skipped") {
    return `    <testcase ${attributes}><skipped message="${escapeXml(`${check.status}: ${check.summary}`)}"/></testcase>`;
  }
  return `    <testcase ${attributes}/>`;
}

export function renderJUnit(report: VerificationReport): string {
  const outcomes = report.checks.map(outcomeFor);
  const failures = outcomes.filter((outcome) => outcome === "failure").length;
  const errors = outcomes.filter((outcome) => outcome === "error").length;
  const skipped = outcomes.filter((outcome) => outcome === "skipped").length;
  const duration = durationSeconds(
    report.checks.reduce((total, check) => total + check.durationMs, 0),
  );
  const testCases = report.checks.map(renderCheck).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="DeployWitness" tests="${report.checks.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${duration}">`,
    `  <testsuite name="deployment-verification" tests="${report.checks.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${duration}">`,
    `    <properties><property name="deployWitness.decision" value="${report.decision}"/></properties>`,
    testCases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
