import type {
  ProviderCapability,
  VerificationConfig,
} from "../contracts/index.js";

type ProviderName = VerificationConfig["provider"];

const CAPABILITIES: Record<
  ProviderName,
  readonly Omit<ProviderCapability, "status">[]
> = {
  coolify: [
    {
      name: "deployment.lookup",
      reason: "The adapter reads application deployment records.",
    },
    {
      name: "deployment.pagination",
      reason:
        "The adapter requests bounded deployment pages using skip and take.",
    },
    {
      name: "deployment.resource-scope",
      reason: "The application UUID scopes the deployment request.",
    },
    {
      name: "deployment.target-filter",
      reason: "Coolify adapter does not select production or preview targets.",
    },
    {
      name: "deployment.team-scope",
      reason: "Coolify adapter does not apply a team scope.",
    },
    {
      name: "deployment.commit-sha",
      reason:
        "The adapter compares the commit SHA returned by deployment records.",
    },
    {
      name: "deployment.image-digest",
      reason:
        "The documented deployment record fields do not provide an observed immutable image digest.",
    },
  ],
  vercel: [
    {
      name: "deployment.lookup",
      reason:
        "The adapter reads deployment records for the configured project.",
    },
    {
      name: "deployment.pagination",
      reason:
        "The adapter follows Vercel's next cursor within a bounded page and time limit.",
    },
    {
      name: "deployment.resource-scope",
      reason:
        "The configured project ID scopes deployment lookup and is checked in the detail response.",
    },
    {
      name: "deployment.target-filter",
      reason:
        "The configured production or preview target scopes deployment lookup.",
    },
    {
      name: "deployment.team-scope",
      reason: "An optional team ID scopes the Vercel API requests.",
    },
    {
      name: "deployment.commit-sha",
      reason:
        "The adapter requests Git source details and compares the full commit SHA.",
    },
    {
      name: "deployment.image-digest",
      reason:
        "The documented deployment detail fields do not provide an observed immutable image digest.",
    },
  ],
};

export function providerCapabilities(
  provider: ProviderName,
  apiAvailable: boolean,
): readonly ProviderCapability[] {
  return CAPABILITIES[provider].map((capability) => {
    const unsupported =
      capability.name === "deployment.image-digest" ||
      (provider === "coolify" &&
        ["deployment.target-filter", "deployment.team-scope"].includes(
          capability.name,
        ));
    if (unsupported) return { ...capability, status: "UNSUPPORTED" };
    if (!apiAvailable)
      return {
        ...capability,
        status: "UNAVAILABLE",
        reason:
          "The provider API did not respond successfully during this run.",
      };
    return { ...capability, status: "SUPPORTED" };
  });
}
