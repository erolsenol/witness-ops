import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/core/**/*.test.ts", "packages/contracts/**/*.test.ts", "apps/agent/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
