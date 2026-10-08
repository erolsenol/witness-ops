import { z } from "zod";
import type { CoolifySnapshot, Project } from "@witness-ops/contracts";

const applicationSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  status: z.string(),
  fqdn: z.string().nullable().optional(),
  git_branch: z.string().nullable().optional(),
  build_pack: z.string().nullable().optional(),
});

type Fetcher = (input: URL, init: RequestInit) => Promise<Response>;

export class CoolifyReader {
  #cached: { readonly until: number; readonly snapshot: CoolifySnapshot } | null = null;

  constructor(
    private readonly token: string | undefined,
    private readonly origin: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async read(projects: readonly Project[]): Promise<CoolifySnapshot> {
    const checkedAt = new Date().toISOString();
    if (!this.token || !this.origin) return { availability: "not_configured", checkedAt, applications: [], error: null };
    if (this.#cached && this.#cached.until > Date.now()) return this.#cached.snapshot;
    try {
      const url = new URL("/api/v1/applications", this.origin);
      if (url.protocol !== "https:") throw new Error("Coolify API requires HTTPS.");
      const response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Coolify API returned HTTP ${response.status}.`);
      const raw: unknown = await response.json();
      const parsed = z.array(applicationSchema).parse(raw);
      const allowed = new Set(projects.flatMap((project) => project.coolifyApplications));
      const snapshot: CoolifySnapshot = {
        availability: "ready",
        checkedAt,
        applications: parsed.filter((application) => allowed.has(application.uuid)).map((application) => ({
          uuid: application.uuid,
          name: application.name,
          status: application.status,
          fqdn: application.fqdn ?? null,
          branch: application.git_branch ?? null,
          buildPack: application.build_pack ?? null,
        })),
        error: null,
      };
      this.#cached = { until: Date.now() + 15_000, snapshot };
      return snapshot;
    } catch (error: unknown) {
      return {
        availability: "unavailable", checkedAt, applications: [],
        error: error instanceof Error && error.message.startsWith("Coolify API") ? error.message : "Coolify API could not be read.",
      };
    }
  }
}
