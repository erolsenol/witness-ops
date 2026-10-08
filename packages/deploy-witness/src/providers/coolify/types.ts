import { z } from "zod";

export const CoolifyDeploymentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    deployment_uuid: z.string().optional(),
    uuid: z.string().optional(),
    commit: z.string().optional(),
    git_commit_sha: z.string().optional(),
    status: z.string().optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
    updated_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export const CoolifyDeploymentListSchema = z.array(CoolifyDeploymentSchema);

export type CoolifyDeployment = z.infer<typeof CoolifyDeploymentSchema>;

export function deploymentSha(
  deployment: CoolifyDeployment,
): string | undefined {
  return deployment.git_commit_sha ?? deployment.commit;
}

export function deploymentTimestamp(deployment: CoolifyDeployment): number {
  const value = deployment.created_at;
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function newestDeployment(
  deployments: readonly CoolifyDeployment[],
): CoolifyDeployment | undefined {
  if (
    deployments.length === 0 ||
    deployments.some(
      (deployment) => !Number.isFinite(deploymentTimestamp(deployment)),
    )
  ) {
    return undefined;
  }
  const newestTimestamp = Math.max(...deployments.map(deploymentTimestamp));
  const newest = deployments.filter(
    (deployment) => deploymentTimestamp(deployment) === newestTimestamp,
  );
  return newest.length === 1 ? newest[0] : undefined;
}
