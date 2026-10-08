import { z } from "zod";

const NumericTimestampSchema = z.union([z.number(), z.string()]).optional();

export const VercelDeploymentListSchema = z.object({
  deployments: z.array(
    z.object({
      uid: z.string().optional(),
      id: z.string().optional(),
      createdAt: NumericTimestampSchema,
      created: NumericTimestampSchema,
    }),
  ),
  pagination: z
    .object({
      next: z.union([z.number(), z.string()]).nullable(),
    })
    .optional(),
});

export const VercelDeploymentDetailSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  readyState: z.string(),
  target: z.string().nullable().optional(),
  createdAt: NumericTimestampSchema,
  created: NumericTimestampSchema,
  gitSource: z
    .object({
      sha: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export type VercelDeploymentSummary = z.infer<
  typeof VercelDeploymentListSchema
>["deployments"][number];
export type VercelDeploymentDetail = z.infer<
  typeof VercelDeploymentDetailSchema
>;

export function vercelTimestamp(
  deployment: Pick<VercelDeploymentSummary, "createdAt" | "created">,
): number | undefined {
  const raw = deployment.createdAt ?? deployment.created;
  if (raw === undefined) return undefined;
  const timestamp = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}
