import { z } from "zod";

export const stepSchema = z.strictObject({
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
});

export const buildSchema = stepSchema.extend({
  manifest: z.string().startsWith(".release-artifacts/").includes("{sha}"),
  verify: stepSchema,
});

export const deploySchema = stepSchema.extend({
  smoke: stepSchema,
}).refine((step) => step.args.some((arg) => arg.includes("{manifest}")), "Deploy command must use {manifest}.")
  .refine((step) => step.smoke.args.some((arg) => arg.includes("{sha}")), "Smoke command must use {sha}.");

export const rollbackSchema = stepSchema.extend({
  smoke: stepSchema,
}).refine((step) => step.args.some((arg) => arg.includes("{sha}")), "Rollback command must use {sha}.")
  .refine((step) => step.smoke.args.some((arg) => arg.includes("{sha}")), "Rollback smoke command must use {sha}.");

export const projectSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  root: z.string().startsWith("/"),
  productionBranch: z.string().min(1),
  nodeVersion: z.string().min(1),
  packageManager: z.string().min(1),
  coolifyApplications: z.array(z.string().min(1)),
  checks: z.array(stepSchema).min(1),
  build: buildSchema.optional(),
  deploy: deploySchema.optional(),
  rollback: rollbackSchema.optional(),
  releaseEvidence: z.strictObject({
    sshTarget: z.string().min(1),
    ledgerDirectory: z.string().startsWith("/"),
    imagePrefix: z.string().min(1),
    containers: z.array(z.strictObject({
      logicalName: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      containerName: z.string().regex(/^[A-Za-z0-9_-]+$/),
    })).min(1),
  }).optional(),
  deployVerification: z.strictObject({
    configPath: z.string().startsWith("/"),
  }).optional(),
  databaseRecovery: z.strictObject({
    configPath: z.string().startsWith("/"),
    projectId: z.string().min(1),
    beforeDeploy: z.boolean().default(false),
  }).optional(),
});

export const configSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(projectSchema),
}).superRefine((config, context) => {
  const ids = new Set<string>();
  for (const project of config.projects) {
    if (ids.has(project.id)) context.addIssue({ code: "custom", message: `Duplicate project ID: ${project.id}` });
    ids.add(project.id);
  }
});

export const createRunSchema = z.discriminatedUnion("action", [
  z.strictObject({ projectId: z.string().min(1), action: z.enum(["plan", "check", "build"]) }),
  z.strictObject({ projectId: z.string().min(1), action: z.enum(["deploy-verify", "db-status", "db-drill"]) }),
  z.strictObject({
    projectId: z.string().min(1), action: z.literal("deploy"),
    expectedSha: z.string().regex(/^[a-f0-9]{40}$/),
    expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    projectId: z.string().min(1), action: z.literal("rollback"),
    expectedSha: z.string().regex(/^[a-f0-9]{40}$/),
  }),
]);

export type Project = z.infer<typeof projectSchema>;
export type Config = z.infer<typeof configSchema>;
export type RunAction = z.infer<typeof createRunSchema>["action"];
export type ReleaseAction = Exclude<RunAction, "deploy-verify" | "db-status" | "db-drill">;
export type ToolAction = Extract<RunAction, "deploy-verify" | "db-status" | "db-drill">;
export type RunStatus = "queued" | "running" | "passed" | "failed" | "needs_attention";

export interface ProjectState {
  readonly id: string;
  readonly name: string;
  readonly branch: string | null;
  readonly sha: string | null;
  readonly clean: boolean | null;
  readonly error: string | null;
  readonly productionBranch: string;
  readonly coolifyApplications: readonly string[];
  readonly buildAvailable: boolean;
  readonly deployAvailable: boolean;
  readonly rollbackAvailable: boolean;
  readonly deployVerificationAvailable: boolean;
  readonly databaseRecoveryAvailable: boolean;
}

export interface BuildArtifactSummary {
  readonly projectId: string;
  readonly sha: string;
  readonly manifestHash: string;
  readonly createdAt: string;
}

export const buildArtifactSummarySchema: z.ZodType<BuildArtifactSummary> = z.strictObject({
  projectId: z.string(), sha: z.string(), manifestHash: z.string(), createdAt: z.string(),
});

export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly action: RunAction;
  readonly status: RunStatus;
  readonly sourceSha: string | null;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

export interface RunEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly at: string;
  readonly kind: "info" | "step" | "result" | "error";
  readonly message: string;
}

export interface CoolifyApplicationStatus {
  readonly uuid: string;
  readonly name: string;
  readonly status: string;
  readonly fqdn: string | null;
  readonly branch: string | null;
  readonly buildPack: string | null;
}

export interface CoolifySnapshot {
  readonly availability: "ready" | "not_configured" | "unavailable";
  readonly checkedAt: string;
  readonly applications: readonly CoolifyApplicationStatus[];
  readonly error: string | null;
}

export interface ReleaseImageEvidence {
  readonly name: string;
  readonly reference: string;
  readonly imageId: string;
}

export interface ReleaseRecordEvidence {
  readonly sha: string;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly images: readonly ReleaseImageEvidence[];
}

export interface RuntimeImageEvidence {
  readonly logicalName: string;
  readonly reference: string;
  readonly imageId: string;
  readonly status: string;
  readonly health: string;
}

export interface ReleaseEvidenceSnapshot {
  readonly availability: "ready" | "unavailable";
  readonly checkedAt: string;
  readonly current: ReleaseRecordEvidence | null;
  readonly rollbackCandidates: readonly ReleaseRecordEvidence[];
  readonly runtimeImages: readonly RuntimeImageEvidence[];
  readonly runtimeMatchesCurrent: boolean | null;
  readonly error: string | null;
}

export const coolifySnapshotSchema: z.ZodType<CoolifySnapshot> = z.strictObject({
  availability: z.enum(["ready", "not_configured", "unavailable"]),
  checkedAt: z.string(),
  applications: z.array(z.strictObject({
    uuid: z.string(), name: z.string(), status: z.string(), fqdn: z.string().nullable(),
    branch: z.string().nullable(), buildPack: z.string().nullable(),
  })),
  error: z.string().nullable(),
});

export const releaseImageEvidenceSchema: z.ZodType<ReleaseImageEvidence> = z.strictObject({
  name: z.string(),
  reference: z.string(),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const releaseRecordEvidenceSchema: z.ZodType<ReleaseRecordEvidence> = z.strictObject({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  state: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  images: z.array(releaseImageEvidenceSchema).min(1),
}).superRefine((record, context) => {
  for (const image of record.images) {
    if (!image.reference.endsWith(`:sha-${record.sha}`)) {
      context.addIssue({ code: "custom", message: "Release image SHA does not match its record." });
    }
  }
});

export const releaseEvidenceSnapshotSchema: z.ZodType<ReleaseEvidenceSnapshot> = z.strictObject({
  availability: z.enum(["ready", "unavailable"]),
  checkedAt: z.string(),
  current: releaseRecordEvidenceSchema.nullable(),
  rollbackCandidates: z.array(releaseRecordEvidenceSchema),
  runtimeImages: z.array(z.strictObject({
    logicalName: z.string(), reference: z.string(), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    status: z.string(), health: z.string(),
  })),
  runtimeMatchesCurrent: z.boolean().nullable(),
  error: z.string().nullable(),
});

export const projectStateSchema: z.ZodType<ProjectState> = z.strictObject({
  id: z.string(), name: z.string(), branch: z.string().nullable(), sha: z.string().nullable(),
  clean: z.boolean().nullable(), error: z.string().nullable(), productionBranch: z.string(),
  coolifyApplications: z.array(z.string()),
  buildAvailable: z.boolean(),
  deployAvailable: z.boolean(),
  rollbackAvailable: z.boolean(),
  deployVerificationAvailable: z.boolean(),
  databaseRecoveryAvailable: z.boolean(),
});

export const runRecordSchema: z.ZodType<RunRecord> = z.strictObject({
  id: z.string(), projectId: z.string(), action: z.enum(["plan", "check", "build", "deploy", "rollback", "deploy-verify", "db-status", "db-drill"]),
  status: z.enum(["queued", "running", "passed", "failed", "needs_attention"]),
  sourceSha: z.string().nullable(), branch: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(), error: z.string().nullable(),
});

export const runEventSchema: z.ZodType<RunEvent> = z.strictObject({
  sequence: z.number().int(), runId: z.string(), at: z.string(),
  kind: z.enum(["info", "step", "result", "error"]), message: z.string(),
});
