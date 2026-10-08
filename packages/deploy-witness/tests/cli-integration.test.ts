import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VerificationReportSchema } from "../src/contracts/index.js";
import { renderMarkdown } from "../src/reporters/markdown.js";

const temporaryDirectories: string[] = [];
const expectedSha = "0123456789abcdef0123456789abcdef01234567";
const providerToken = "local-integration-token";

describe.each(["cli", "action"] as const)(
  "%s concurrency integration",
  (surface) => {
    it("applies an explicit single-worker limit to real runtime requests", async () => {
      const result = await runIntegration({
        runtimeSha: expectedSha,
        surface,
        probeConcurrency: 1,
      });
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.maximumActiveRuntimeRequests).toBe(1);
      expect(
        result.report.checks
          .filter((check) => check.id.startsWith("http."))
          .map((check) => check.id),
      ).toEqual(["http.health", "http.runtime-version"]);
    });
  },
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI local Coolify integration", () => {
  it("verifies deployment and runtime markers, then writes redacted JSON and JUnit reports", async () => {
    const result = await runIntegration({ runtimeSha: expectedSha });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Decision: PASS");
    expect(result.apiAuthorization).toBe(`Bearer ${providerToken}`);
    expect(result.apiPath).toBe(
      "/api/v1/deployments/applications/local-app?skip=0&take=20",
    );
    expect(result.report.decision).toBe("PASS");
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "deployment.commit", status: "PASS" }),
        expect.objectContaining({ id: "http.health", status: "PASS" }),
        expect.objectContaining({ id: "http.runtime-version", status: "PASS" }),
      ]),
    );
    expect(result.reportText).not.toContain(providerToken);
    expect(result.junitText).toContain('tests="6"');
    expect(result.junitText).not.toContain(providerToken);
    expect(result.markdownText).toBe(
      renderMarkdown(VerificationReportSchema.parse(result.report)),
    );
    expect(result.markdownText).not.toContain(providerToken);
    expect(result.reportMode & 0o777).toBe(0o600);
    expect((result.junitMode ?? 0) & 0o777).toBe(0o600);
  });

  it("fails when a healthy runtime exposes a different commit marker", async () => {
    const result = await runIntegration({ runtimeSha: "a".repeat(40) });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Decision: FAIL");
    expect(result.report.decision).toBe("FAIL");
    expect(
      result.report.checks.find((check) => check.id === "deployment.commit")
        ?.status,
    ).toBe("PASS");
    expect(
      result.report.checks.find((check) => check.id === "http.runtime-version")
        ?.status,
    ).toBe("FAIL");
    expect(result.reportText).not.toContain(providerToken);
  });
});

describe("GitHub Action local Coolify integration", () => {
  it("uses Action inputs and emits a PASS output and step summary", async () => {
    const result = await runIntegration({
      runtimeSha: expectedSha,
      surface: "action",
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.outputsText).toMatch(/decision<<[^\r\n]+\r?\nPASS\r?\n/);
    expect(result.outputsText).toContain(result.reportPath);
    expect(result.summaryText).toContain("DeployWitness: PASS");
    expect(result.summaryText).toContain("http.runtime-version");
    expect(result.summaryText).toBe(
      renderMarkdown(VerificationReportSchema.parse(result.report)),
    );
    expect(result.report.decision).toBe("PASS");
    expect(result.reportText).not.toContain(providerToken);
    expect(result.apiAuthorization).toBe(`Bearer ${providerToken}`);
    expect(result.reportMode & 0o777).toBe(0o600);
  });

  it("marks the Action failed when a healthy runtime has the wrong commit", async () => {
    const result = await runIntegration({
      runtimeSha: "a".repeat(40),
      surface: "action",
    });

    expect(result.exitCode).toBe(1);
    expect(result.outputsText).toMatch(/decision<<[^\r\n]+\r?\nFAIL\r?\n/);
    expect(result.summaryText).toContain("DeployWitness: FAIL");
    expect(result.report.decision).toBe("FAIL");
    expect(result.reportText).not.toContain(providerToken);
  });
});

interface RunResult {
  readonly maximumActiveRuntimeRequests: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: {
    readonly decision: string;
    readonly checks: readonly {
      readonly id: string;
      readonly status: string;
    }[];
  };
  readonly reportText: string;
  readonly reportPath: string;
  readonly junitText?: string;
  readonly markdownText?: string;
  readonly summaryText?: string;
  readonly outputsText?: string;
  readonly reportMode: number;
  readonly junitMode?: number;
  readonly apiAuthorization: string | undefined;
  readonly apiPath: string | undefined;
}

async function runIntegration({
  runtimeSha,
  surface = "cli",
  probeConcurrency,
}: {
  readonly runtimeSha: string;
  readonly surface?: "cli" | "action";
  readonly probeConcurrency?: number;
}): Promise<RunResult> {
  const directory = await mkdtemp(join(tmpdir(), "deploy-witness-e2e-"));
  temporaryDirectories.push(directory);

  let apiAuthorization: string | undefined;
  let apiPath: string | undefined;
  let activeRuntimeRequests = 0;
  let maximumActiveRuntimeRequests = 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${address.port}`;
  const deploymentStartedAt = new Date(Date.now() - 60_000).toISOString();

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/api/v1/deployments/applications/local-app") {
      apiAuthorization = request.headers.authorization;
      apiPath = `${url.pathname}${url.search}`;
      if (
        request.method !== "GET" ||
        apiAuthorization !== `Bearer ${providerToken}`
      ) {
        response.writeHead(403).end("local fixture rejected provider request");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            deployment_uuid: "local-deployment",
            status: "finished",
            commit: expectedSha,
            created_at: new Date().toISOString(),
          },
        ]),
      );
      return;
    }
    if (url.pathname === "/health" || url.pathname === "/version") {
      activeRuntimeRequests += 1;
      maximumActiveRuntimeRequests = Math.max(
        maximumActiveRuntimeRequests,
        activeRuntimeRequests,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      activeRuntimeRequests -= 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          url.pathname === "/health"
            ? { status: "ok" }
            : { build: { commit: runtimeSha } },
        ),
      );
      return;
    }
    response.writeHead(404).end();
  }

  try {
    const configPath = join(directory, "deploy-witness.json");
    const reportPath = join(directory, "report.json");
    const junitPath = join(directory, "report.xml");
    const markdownPath = join(directory, "report.md");
    const summaryPath = join(directory, "summary.md");
    const outputsPath = join(directory, "outputs");
    await writeFile(summaryPath, "", { mode: 0o600 });
    await writeFile(outputsPath, "", { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        provider: "coolify",
        coolify: { baseUrl, resourceUuid: "local-app" },
        deployment: { timeoutSeconds: 10, pollIntervalSeconds: 1 },
        probes: [
          {
            name: "health",
            url: `${baseUrl}/health`,
            allowLocalHttp: true,
          },
          {
            name: "runtime-version",
            url: `${baseUrl}/version`,
            allowLocalHttp: true,
            expectedJson: { path: "build.commit", value: expectedSha },
          },
        ],
      }),
      { mode: 0o600 },
    );

    const actionInputs = {
      ...(probeConcurrency !== undefined
        ? { "INPUT_PROBE-CONCURRENCY": String(probeConcurrency) }
        : {}),
      INPUT_CONFIG: configPath,
      "INPUT_COOLIFY-TOKEN": providerToken,
      "INPUT_EXPECTED-SHA": expectedSha,
      "INPUT_STARTED-AFTER": deploymentStartedAt,
      "INPUT_REPORT-PATH": reportPath,
      GITHUB_OUTPUT: outputsPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    };
    const cliArguments = [
      "--import",
      "tsx",
      "src/cli.ts",
      "verify",
      "--config",
      configPath,
      "--expected-sha",
      expectedSha,
      "--started-after",
      deploymentStartedAt,
      "--report",
      reportPath,
      "--junit",
      junitPath,
      "--markdown",
      markdownPath,
      ...(probeConcurrency !== undefined
        ? ["--probe-concurrency", String(probeConcurrency)]
        : []),
    ];
    const child = spawn(
      process.execPath,
      surface === "cli"
        ? cliArguments
        : ["--import", "tsx", "src/action/index.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(surface === "cli"
            ? { COOLIFY_API_TOKEN: providerToken }
            : actionInputs),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [exitCode] = (await once(child, "close")) as [number | null];
    const reportText = await readFile(reportPath, "utf8");
    const report = JSON.parse(reportText) as RunResult["report"];
    const reportMetadata = await stat(reportPath);
    const junitText =
      surface === "cli" ? await readFile(junitPath, "utf8") : undefined;
    const junitMetadata = surface === "cli" ? await stat(junitPath) : undefined;

    return {
      maximumActiveRuntimeRequests,
      exitCode: exitCode ?? -1,
      stdout,
      stderr,
      report,
      reportText,
      reportPath,
      ...(junitText ? { junitText } : {}),
      ...(surface === "cli"
        ? { markdownText: await readFile(markdownPath, "utf8") }
        : {}),
      ...(surface === "action"
        ? {
            summaryText: await readFile(summaryPath, "utf8"),
            outputsText: await readFile(outputsPath, "utf8"),
          }
        : {}),
      reportMode: reportMetadata.mode,
      ...(junitMetadata ? { junitMode: junitMetadata.mode } : {}),
      apiAuthorization,
      apiPath,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
