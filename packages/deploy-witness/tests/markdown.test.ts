import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type VerificationReport,
  VerificationReportSchema,
} from "../src/contracts/index.js";
import { renderMarkdown } from "../src/reporters/markdown.js";

async function report(): Promise<VerificationReport> {
  return VerificationReportSchema.parse(
    JSON.parse(await readFile("examples/report-pass-v1.json", "utf8")),
  );
}

describe("Markdown reporter", () => {
  it("includes identity and all check outcomes without raw evidence values", async () => {
    const base = await report();
    const first = base.checks[0];
    if (!first) throw new Error("Fixture must contain checks");
    const markdown = renderMarkdown({
      ...base,
      checks: [
        {
          ...first,
          required: false,
          status: "FAIL",
          failureCode: "SOME_FAILURE",
          evidence: [
            {
              source: "fixture",
              field: "token",
              observedAt: base.createdAt,
              observed: "private-observation",
            },
          ],
        },
      ],
    });
    expect(markdown).toContain(`## DeployWitness: ${base.decision}`);
    expect(markdown).toContain(base.expectedSha);
    expect(markdown).toContain(base.runId);
    expect(markdown).toContain(base.createdAt);
    expect(markdown).toContain("| no | FAIL | SOME_FAILURE |");
    expect(markdown).not.toContain("private-observation");
  });
  it("escapes HTML, Markdown, tables, newlines and directional controls", async () => {
    const base = await report();
    const attack =
      "<script>alert(1)</script> | [click](javascript:alert(1)) **bold** `code` &entity;\n## forged\r\u001b\u202e";
    const markdown = renderMarkdown({
      ...base,
      resourceUuid: attack,
      toolVersion: attack,
      checks: base.checks.map((check) => ({ ...check, summary: attack })),
    });
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[click]");
    expect(markdown).not.toContain("**bold**");
    expect(markdown).not.toContain("`code`");
    expect(markdown).toContain("&#60;script&#62;");
    expect(markdown).toContain("&#124;");
    expect(markdown).not.toContain("\n## forged");
    for (const control of ["\r", "\u001b", "\u202e"])
      expect(markdown).not.toContain(control);
    const rows = markdown.split("\n").filter((line) => line.startsWith("|"));
    expect(rows).toHaveLength(base.checks.length + 2);
    for (const row of rows) expect(row.split("|")).toHaveLength(7);
  });
  it("preserves ordinary Unicode and produces deterministic output", async () => {
    const base = await report();
    const value = { ...base, resourceUuid: "Türkçe uygulama 😀" };
    expect(renderMarkdown(value)).toContain("Türkçe uygulama 😀");
    expect(renderMarkdown(value)).toBe(renderMarkdown(value));
  });
});
