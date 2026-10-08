import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface GitLabJob {
  readonly stage: string;
  readonly image?: string;
  readonly needs?: readonly {
    readonly job: string;
    readonly artifacts: boolean;
  }[];
  readonly script: readonly string[];
  readonly artifacts?: {
    readonly reports?: { readonly dotenv?: string };
  };
}

describe("published CI consumer examples", () => {
  it("keeps the GitLab deploy boundary connected to a secret-safe verify job", async () => {
    const example = parse(await readFile("examples/gitlab-ci.yml", "utf8")) as {
      readonly stages: readonly string[];
      readonly deploy_staging: GitLabJob;
      readonly verify_staging: GitLabJob & {
        readonly environment: { readonly name: string };
      };
    };

    expect(example.stages).toEqual(["deploy", "verify"]);
    expect(example.deploy_staging.artifacts?.reports?.dotenv).toBe(
      "deploy.env",
    );
    expect(example.deploy_staging.script[0]).toContain("DEPLOY_STARTED_AT=");
    expect(example.verify_staging.image).toBe("node:22");
    expect(example.verify_staging.environment.name).toBe("staging");
    expect(example.verify_staging.needs).toContainEqual({
      job: "deploy_staging",
      artifacts: true,
    });
    expect(example.verify_staging.script).toEqual(
      expect.arrayContaining([
        expect.stringContaining("deploy-witness@0.5.0"),
        expect.stringContaining(
          'export COOLIFY_API_TOKEN="$COOLIFY_READ_ONLY_TOKEN"',
        ),
        expect.stringContaining('--expected-sha "$CI_COMMIT_SHA"'),
        expect.stringContaining('--started-after "$DEPLOY_STARTED_AT"'),
      ]),
    );
  });

  it("pins the GitHub Action example to a full release commit SHA", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain(
      "uses: erolsenol/deploy-witness@42bef07ebcf0a66097ce4c67325b7916a195c044",
    );
  });

  it("waits for npm publication and verifies the registry consumer", async () => {
    const workflow = parse(
      await readFile("../../.github/workflows/publish-npm.yml", "utf8"),
    ) as {
      readonly jobs: {
        readonly publish: {
          readonly steps: readonly {
            readonly name?: string;
            readonly run?: string;
            readonly env?: Readonly<Record<string, string>>;
          }[];
        };
      };
    };
    const steps = workflow.jobs.publish.steps;

    const accountCheckIndex = steps.findIndex(
      (step) => step.name === "Verify npm publisher account",
    );
    const publishIndex = steps.findIndex(
      (step) => step.name === "Publish as erol.senol with provenance",
    );
    expect(accountCheckIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(accountCheckIndex);
    expect(steps[publishIndex]?.run).toContain("--provenance");
    const accountCheck = steps[accountCheckIndex];
    expect(accountCheck?.run).toContain('if [ -z "$NODE_AUTH_TOKEN" ]');
    expect(accountCheck?.run).toContain(
      'test "$(npm whoami --registry=https://registry.npmjs.org)" = "erol.senol"',
    );
    for (const index of [accountCheckIndex, publishIndex]) {
      expect(steps[index]?.env?.NODE_AUTH_TOKEN).toBe(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax.
        "${{ secrets.NPM_TOKEN }}",
      );
    }

    expect(steps.map((step) => step.name)).toContain(
      "Wait for registry visibility and verify source commit",
    );
    expect(steps.map((step) => step.name)).toContain(
      "Smoke-test the published registry package",
    );
    expect(
      steps.find(
        (step) =>
          step.name === "Wait for registry visibility and verify source commit",
      )?.run,
    ).toContain("for attempt in {1..48}");
    const registryCheck = await readFile(
      "../../scripts/check-registry-release.mjs",
      "utf8",
    );
    expect(registryCheck).toContain("metadata.gitHead !== process.env.GITHUB_SHA");
    expect(registryCheck).toContain('metadata._npmUser?.name !== "erol.senol"');
    expect(
      steps.find(
        (step) => step.name === "Smoke-test the published registry package",
      )?.run,
    ).toContain("deploy schema config-v2");
  });
});
