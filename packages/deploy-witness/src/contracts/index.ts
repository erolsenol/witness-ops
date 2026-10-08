import { z } from "zod";
import { httpProbeCheckId } from "./check-id.js";

export { httpProbeCheckId } from "./check-id.js";

function validateProbeCheckIds(
  config: { readonly probes: readonly { readonly name: string }[] },
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  config.probes.forEach((probe, index) => {
    const id = httpProbeCheckId(probe.name);
    if (ids.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["probes", index, "name"],
        message: "Probe names must produce unique check IDs.",
      });
    }
    ids.add(id);
  });
}

export const CheckStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "WARN",
  "SKIP",
  "UNKNOWN",
  "UNSUPPORTED",
]);

export const EvidenceValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const EvidenceSchema = z
  .object({
    source: z.string().min(1),
    observedAt: z.string().datetime({ offset: true }),
    field: z.string().min(1),
    expected: EvidenceValueSchema.optional(),
    observed: EvidenceValueSchema.optional(),
  })
  .strict();

export const CheckResultSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    category: z.enum(["provider", "deployment", "runtime", "config"]),
    required: z.boolean(),
    status: CheckStatusSchema,
    summary: z.string().min(1),
    durationMs: z.number().nonnegative(),
    evidence: z.array(EvidenceSchema).default([]),
    failureCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  })
  .strict();

export const VerificationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolVersion: z.string().min(1),
    runId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    expectedSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    provider: z.enum(["coolify", "vercel"]),
    resourceUuid: z.string().min(1),
    decision: z.enum(["PASS", "FAIL", "INCOMPLETE"]),
    capabilities: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
            status: z.enum(["SUPPORTED", "UNSUPPORTED", "UNAVAILABLE"]),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    checks: z.array(CheckResultSchema),
  })
  .strict();

const HttpProbeSchema = z
  .object({
    name: z.string().min(1).max(64),
    url: z.string().url(),
    required: z.boolean().default(true),
    allowLocalHttp: z.boolean().default(false),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    timeoutMs: z.number().int().min(250).max(30_000).default(5_000),
    stability: z
      .object({
        consecutiveSuccesses: z.number().int().min(1).max(10).default(1),
        intervalMs: z.number().int().min(100).max(10_000).default(1_000),
      })
      .strict()
      .optional(),
    expectedHeader: z
      .object({ name: z.string().min(1), value: z.string() })
      .strict()
      .optional()
      .refine(
        (header) =>
          !header ||
          ![
            "authorization",
            "proxy-authorization",
            "www-authenticate",
            "proxy-authenticate",
            "set-cookie",
            "cookie",
          ].includes(header.name.toLowerCase()),
        "Sensitive response headers cannot be used as runtime markers.",
      ),
    expectedJson: z
      .object({ path: z.string().min(1), value: EvidenceValueSchema })
      .strict()
      .optional(),
  })
  .strict();

const HttpProbeV2Schema = HttpProbeSchema.extend({
  imageDigestJsonPath: z.string().min(1).optional(),
})
  .strict()
  .superRefine((probe, context) => {
    if (probe.imageDigestJsonPath && probe.expectedJson) {
      context.addIssue({
        code: "custom",
        path: ["imageDigestJsonPath"],
        message:
          "Use either imageDigestJsonPath or expectedJson on a probe, not both.",
      });
    }
  });

const CommonDeploymentConfigSchema = z
  .object({
    expectedSha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .optional(),
    startedAfter: z.string().datetime({ offset: true }).optional(),
    timeoutSeconds: z.number().int().min(10).max(1800).default(600),
    pollIntervalSeconds: z.number().int().min(1).max(60).default(5),
  })
  .strict();

const CommonConfigFields = z.object({
  provider: z.enum(["coolify", "vercel"]),
  deployment: CommonDeploymentConfigSchema,
  probes: z.array(HttpProbeSchema).max(20).default([]),
});

const CommonConfigV1Fields = z
  .object({ version: z.literal(1) })
  .extend(CommonConfigFields.shape);

const ConfigV1Schema = z.discriminatedUnion("provider", [
  CommonConfigV1Fields.extend({
    provider: z.literal("coolify"),
    coolify: z
      .object({
        baseUrl: z.string().url(),
        resourceUuid: z.string().min(1).max(128),
      })
      .strict(),
  }).strict(),
  CommonConfigV1Fields.extend({
    provider: z.literal("vercel"),
    vercel: z
      .object({
        projectId: z.string().min(1).max(128),
        teamId: z.string().min(1).max(128).optional(),
        target: z.enum(["production", "preview"]),
      })
      .strict(),
  }).strict(),
]);

const DeploymentConfigV2Schema = CommonDeploymentConfigSchema.extend({
  expectedImageDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/i)
    .optional(),
}).strict();

const CommonConfigV2Fields = z
  .object({ version: z.literal(2) })
  .extend(CommonConfigFields.shape)
  .extend({
    deployment: DeploymentConfigV2Schema,
    probes: z.array(HttpProbeV2Schema).max(20).default([]),
  });

export const VerificationConfigV2Schema = z
  .discriminatedUnion("provider", [
    CommonConfigV2Fields.extend({
      provider: z.literal("coolify"),
      coolify: z
        .object({
          baseUrl: z.string().url(),
          resourceUuid: z.string().min(1).max(128),
        })
        .strict(),
    }).strict(),
    CommonConfigV2Fields.extend({
      provider: z.literal("vercel"),
      vercel: z
        .object({
          projectId: z.string().min(1).max(128),
          teamId: z.string().min(1).max(128).optional(),
          target: z.enum(["production", "preview"]),
        })
        .strict(),
    }).strict(),
  ])
  .superRefine((config, context) => {
    validateProbeCheckIds(config, context);
    if (
      config.probes.some((probe) => probe.imageDigestJsonPath) &&
      !config.deployment.expectedImageDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["deployment", "expectedImageDigest"],
        message:
          "deployment.expectedImageDigest is required when a probe uses imageDigestJsonPath.",
      });
    }
  });

export const VerificationConfigV1Schema = ConfigV1Schema.superRefine(
  validateProbeCheckIds,
);
export const VerificationConfigSchema = z.union([
  VerificationConfigV1Schema,
  VerificationConfigV2Schema,
]);

export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type ProviderCapability = VerificationReport["capabilities"][number];
export type HttpProbeConfig =
  | z.infer<typeof HttpProbeSchema>
  | z.infer<typeof HttpProbeV2Schema>;
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

export function decide(
  checks: readonly CheckResult[],
): VerificationReport["decision"] {
  const required = checks.filter((check) => check.required);

  if (required.some((check) => check.status === "FAIL")) return "FAIL";
  if (
    required.some(
      (check) =>
        check.status === "UNKNOWN" ||
        check.status === "UNSUPPORTED" ||
        check.status === "SKIP",
    )
  ) {
    return "INCOMPLETE";
  }
  if (required.some((check) => check.status !== "PASS")) return "FAIL";
  return "PASS";
}
