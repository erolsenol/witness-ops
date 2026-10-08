import type { Project, ReleaseAction } from "@deploy-relay/contracts";

export interface CliRequest {
  readonly action: ReleaseAction;
  readonly projectIds: readonly string[];
  readonly dryRun: boolean;
  readonly expectedSha?: string;
  readonly expectedManifestHash?: string;
}

export function parseCliArgs(args: readonly string[], projects: readonly Project[]): CliRequest {
  const [action, ...options] = args;
  if (action !== "plan" && action !== "check" && action !== "build" && action !== "deploy" && action !== "rollback") {
    throw new Error("Usage: witness release <plan|check|build|deploy|rollback> <--all|--project ID> [--sha SHA] [--manifest-hash HASH] [--confirm SHA12] [--dry-run]");
  }
  let all = false;
  let projectId: string | null = null;
  let expectedSha: string | undefined;
  let expectedManifestHash: string | undefined;
  let confirmation: string | undefined;
  let dryRun = action === "plan";
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--all") all = true;
    else if (option === "--dry-run") dryRun = true;
    else if (option === "--project") projectId = options[++index] ?? null;
    else if (option === "--sha") expectedSha = options[++index];
    else if (option === "--manifest-hash") expectedManifestHash = options[++index];
    else if (option === "--confirm") confirmation = options[++index];
    else throw new Error(`Unknown option: ${option}`);
  }
  if (all === Boolean(projectId)) throw new Error("Choose exactly one of --all or --project ID.");
  const selected = all ? projects : projects.filter((project) => project.id === projectId);
  if (selected.length === 0 && !all) throw new Error(`Unknown project: ${projectId}`);
  if (selected.length === 0 && action !== "plan") throw new Error("No projects are configured.");
  if (action === "build" && selected.some((project) => !project.build)) {
    throw new Error("Build is not configured for every selected project.");
  }
  if ((action === "rollback" || action === "deploy") && all) throw new Error(`${action} requires exactly one --project.`);
  if (action === "deploy" && selected.some((project) => !project.deploy || !project.build)) {
    throw new Error("Deploy is not configured for the selected project.");
  }
  if (action === "deploy" && (!expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha) || !expectedManifestHash || !/^[a-f0-9]{64}$/.test(expectedManifestHash))) {
    throw new Error("Deploy requires --sha and --manifest-hash from a verified build.");
  }
  if (action === "deploy" && !dryRun && confirmation !== expectedSha?.slice(0, 12)) {
    throw new Error("Deploy requires --confirm with the first 12 characters of the source SHA.");
  }
  if (action === "rollback" && selected.some((project) => !project.rollback)) throw new Error("Rollback is not configured for the selected project.");
  if (action === "rollback" && (!expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha))) {
    throw new Error("Rollback requires --sha with a full 40-character commit SHA.");
  }
  if (action !== "rollback" && action !== "deploy" && expectedSha) throw new Error("--sha is only valid for deploy or rollback.");
  if (action !== "deploy" && (expectedManifestHash || confirmation)) throw new Error("--manifest-hash and --confirm are only valid for deploy.");
  return { action, projectIds: selected.map((project) => project.id), dryRun, ...(expectedSha ? { expectedSha } : {}), ...(expectedManifestHash ? { expectedManifestHash } : {}) };
}
