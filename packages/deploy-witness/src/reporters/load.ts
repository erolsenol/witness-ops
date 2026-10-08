import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  decide,
  type VerificationReport,
  VerificationReportSchema,
} from "../contracts/index.js";

export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

type ReportLoadCode =
  | "REPORT_READ_FAILED"
  | "REPORT_TOO_LARGE"
  | "REPORT_INVALID"
  | "REPORT_INCONSISTENT";

export class ReportLoadError extends Error {
  constructor(readonly code: ReportLoadCode) {
    super(`${code}: Saved report could not be validated safely.`);
    this.name = "ReportLoadError";
  }
}

/** Validates stored evidence structure and decision consistency, not authenticity. */
export function parseVerificationReport(value: unknown): VerificationReport {
  const parsed = VerificationReportSchema.safeParse(value);
  if (!parsed.success) throw new ReportLoadError("REPORT_INVALID");
  const report = parsed.data;
  const ids = new Set(report.checks.map((check) => check.id));
  if (
    report.checks.length === 0 ||
    !report.checks.some((check) => check.required) ||
    ids.size !== report.checks.length ||
    report.decision !== decide(report.checks)
  ) {
    throw new ReportLoadError("REPORT_INCONSISTENT");
  }
  return report;
}

export async function loadVerificationReport(
  path: string,
): Promise<VerificationReport> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let contents: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new ReportLoadError("REPORT_READ_FAILED");
      if (metadata.size > MAX_REPORT_BYTES)
        throw new ReportLoadError("REPORT_TOO_LARGE");
      // Read one byte past the limit to detect a file growing after stat.
      const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          total,
          buffer.length - total,
          null,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_REPORT_BYTES)
        throw new ReportLoadError("REPORT_TOO_LARGE");
      contents = buffer.subarray(0, total);
    } finally {
      await file.close();
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(contents),
      );
    } catch {
      throw new ReportLoadError("REPORT_INVALID");
    }
    return parseVerificationReport(value);
  } catch (error) {
    if (error instanceof ReportLoadError) throw error;
    throw new ReportLoadError("REPORT_READ_FAILED");
  }
}
