import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicJsonSchema } from "../src/contracts/json-schema.js";

describe("public JSON Schemas", () => {
  it.each(["config-v1", "config-v2", "report"] as const)(
    "keeps the checked-in %s schema synchronized with the runtime contract",
    async (name) => {
      const path = join(
        process.cwd(),
        "schemas",
        name === "report" ? "report-v1.schema.json" : `${name}.schema.json`,
      );
      const checkedIn = await readFile(path, "utf8");
      const generated = `${JSON.stringify(createPublicJsonSchema(name), null, 2)}\n`;
      expect(checkedIn).toBe(generated);
      expect(JSON.parse(checkedIn)).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title:
          name === "report"
            ? "DeployWitness Verification Report v1"
            : `DeployWitness Configuration ${name === "config-v1" ? "v1" : "v2"}`,
      });
    },
  );
});
