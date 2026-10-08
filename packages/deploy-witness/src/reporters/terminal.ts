import type { VerificationReport } from "../contracts/index.js";

function terminalText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029
      ? " "
      : character;
  }).join("");
}

export function renderTerminal(report: VerificationReport): string {
  return [
    ...report.checks.map(
      (check) =>
        `${check.status.padEnd(11)} ${check.id} — ${terminalText(check.summary)}`,
    ),
    `Decision: ${report.decision} (run ${report.runId})`,
  ].join("\n");
}

export function verificationExitCode(report: VerificationReport): 0 | 1 | 3 {
  return report.decision === "PASS" ? 0 : report.decision === "FAIL" ? 1 : 3;
}
