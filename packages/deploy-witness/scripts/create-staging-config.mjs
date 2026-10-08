import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.env.DW_STAGING_CONFIRM_NONPRODUCTION !== "true") {
  throw new Error(
    "Confirm the Coolify resource is non-production before running staging E2E.",
  );
}

function publicHttpsUrl(name) {
  const value = required(name);
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }
  return url.toString();
}

const baseUrl = publicHttpsUrl("DW_STAGING_COOLIFY_BASE_URL");
const resourceUuid = required("DW_STAGING_COOLIFY_RESOURCE_UUID");
const healthUrl = publicHttpsUrl("DW_STAGING_HEALTH_URL");
const versionUrl = publicHttpsUrl("DW_STAGING_VERSION_URL");
const versionJsonPath =
  process.env.DW_STAGING_VERSION_JSON_PATH?.trim() || "commit";
const expectedSha = required("DW_STAGING_EXPECTED_SHA");
const startedAfter = required("DW_STAGING_STARTED_AFTER");

if (!/^[a-f0-9]{40,64}$/i.test(expectedSha)) {
  throw new Error("DW_STAGING_EXPECTED_SHA must be a full commit SHA.");
}
if (
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
    startedAfter,
  ) ||
  !Number.isFinite(Date.parse(startedAfter))
) {
  throw new Error(
    "DW_STAGING_STARTED_AFTER must be an ISO timestamp with a timezone.",
  );
}

const differentSha = `${expectedSha[0] === "0" ? "1" : "0"}${expectedSha.slice(1)}`;
const directory = required("RUNNER_TEMP");
const outputPath = required("GITHUB_OUTPUT");

function configuration(markerSha) {
  return {
    version: 2,
    provider: "coolify",
    coolify: { baseUrl, resourceUuid },
    deployment: { timeoutSeconds: 120, pollIntervalSeconds: 5 },
    probes: [
      {
        name: "staging-health",
        url: healthUrl,
        required: true,
        expectedStatus: 200,
      },
      {
        name: "staging-commit",
        url: versionUrl,
        required: true,
        expectedStatus: 200,
        expectedJson: { path: versionJsonPath, value: markerSha },
      },
    ],
  };
}

const configs = {
  positive: configuration(expectedSha),
  shaMismatch: configuration(expectedSha),
  markerMismatch: configuration(differentSha),
};
const paths = {};
for (const [name, config] of Object.entries(configs)) {
  const path = join(directory, `deploy-witness-${name}.json`);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  paths[name] = path;
}

await appendFile(
  outputPath,
  `${[
    `positive_config=${paths.positive}`,
    `sha_mismatch_config=${paths.shaMismatch}`,
    `marker_mismatch_config=${paths.markerMismatch}`,
    `sha_mismatch_expected=${differentSha}`,
    `expected_sha=${expectedSha}`,
  ].join("\n")}\n`,
  { encoding: "utf8", mode: 0o600 },
);
