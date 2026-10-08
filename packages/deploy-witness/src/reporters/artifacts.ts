import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface ReportArtifact {
  readonly path: string;
  readonly contents: string;
}

export class ReportWriteError extends Error {
  constructor(readonly code: "REPORT_OUTPUT_CONFLICT" | "REPORT_WRITE_FAILED") {
    super(`${code}: Report artifacts could not be written safely.`);
    this.name = "ReportWriteError";
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Preflights the whole output set, then atomically replaces each file separately. */
export async function writeReportArtifacts(
  artifacts: readonly ReportArtifact[],
  protectedPaths: readonly string[] = [],
): Promise<void> {
  if (artifacts.length === 0) return;
  const identities = new Set<string>();
  const paths = new Set<string>();
  const destinations: string[] = [];
  try {
    for (const path of protectedPaths) {
      const source = await realpath(path);
      paths.add(source);
      const file = await lstat(source);
      identities.add(`${file.dev}:${file.ino}`);
    }
    for (const artifact of artifacts) {
      const absolute = resolve(artifact.path);
      const destination = join(
        await realpath(dirname(absolute)),
        basename(absolute),
      );
      if (paths.has(destination))
        throw new ReportWriteError("REPORT_OUTPUT_CONFLICT");
      paths.add(destination);
      try {
        const file = await lstat(destination);
        if (!file.isFile())
          throw new ReportWriteError("REPORT_OUTPUT_CONFLICT");
        const identity = `${file.dev}:${file.ino}`;
        if (identities.has(identity))
          throw new ReportWriteError("REPORT_OUTPUT_CONFLICT");
        identities.add(identity);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      destinations.push(destination);
    }
    for (const [index, artifact] of artifacts.entries()) {
      const destination = destinations[index];
      if (!destination) throw new ReportWriteError("REPORT_WRITE_FAILED");
      const temporary = join(
        dirname(destination),
        `.deploy-witness-${randomUUID()}.tmp`,
      );
      let created = false;
      try {
        const file = await open(temporary, "wx", 0o600);
        created = true;
        try {
          await file.writeFile(artifact.contents, { encoding: "utf8" });
        } finally {
          await file.close();
        }
        await rename(temporary, destination);
      } finally {
        if (created)
          await unlink(temporary).catch((error: unknown) => {
            if (!missing(error)) throw error;
          });
      }
    }
  } catch (error) {
    if (error instanceof ReportWriteError) throw error;
    throw new ReportWriteError("REPORT_WRITE_FAILED");
  }
}
