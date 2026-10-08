import { readFile } from "node:fs/promises";
import { VerificationReportSchema } from "../src/contracts/index.js";

const [scenario, reportPath] = process.argv.slice(2);
if (!scenario || !reportPath) {
  throw new Error("Usage: check-staging-report <scenario> <report-path>");
}

const rawReport = await readFile(reportPath, "utf8");
const reportResult = VerificationReportSchema.safeParse(JSON.parse(rawReport));
if (!reportResult.success) {
  throw new Error("Staging verification report does not match report v1.");
}

const report = reportResult.data;
const token = process.env.DW_STAGING_COOLIFY_TOKEN;
if (!token) throw new Error("DW_STAGING_COOLIFY_TOKEN is required.");
if (rawReport.includes(token)) {
  throw new Error("A provider token was found in the verification report.");
}

const checks = new Map(report.checks.map((check) => [check.id, check]));
const requireCheck = (id, predicate, message) => {
  const check = checks.get(id);
  if (!check || !predicate(check)) throw new Error(message);
};

if (scenario === "positive") {
  if (report.decision !== "PASS") {
    throw new Error("Expected staging verification to PASS.");
  }
  for (const id of [
    "deployment.status",
    "deployment.commit",
    "deployment.freshness",
    "http.staging-health",
    "http.staging-commit",
  ]) {
    requireCheck(
      id,
      (check) => check.status === "PASS",
      `Expected required check ${id} to PASS.`,
    );
  }
} else if (scenario === "sha-mismatch") {
  if (report.decision !== "FAIL") {
    throw new Error("Expected the wrong SHA control to FAIL.");
  }
  requireCheck(
    "deployment.commit",
    (check) =>
      check.status === "FAIL" &&
      check.failureCode === "DEPLOYMENT_SHA_MISMATCH",
    "Wrong SHA did not fail the deployment commit check.",
  );
} else if (scenario === "marker-mismatch") {
  if (report.decision !== "FAIL") {
    throw new Error("Expected the wrong runtime marker control to FAIL.");
  }
  requireCheck(
    "deployment.commit",
    (check) => check.status === "PASS",
    "The deployment SHA must remain correct for the marker control.",
  );
  requireCheck(
    "http.staging-commit",
    (check) => check.status === "FAIL",
    "A healthy app with the wrong runtime marker did not fail.",
  );
} else {
  throw new Error(`Unknown staging report scenario: ${scenario}`);
}

process.stdout.write(
  `Staging ${scenario} report passed its acceptance checks.\n`,
);
