export const DEFAULT_PROBE_CONCURRENCY = 4;
export const MAX_PROBE_CONCURRENCY = 20;

export class ProbeConcurrencyError extends Error {
  constructor() {
    super("PROBE_CONCURRENCY_INVALID: Provide an integer from 1 to 20.");
    this.name = "ProbeConcurrencyError";
  }
}

export function parseProbeConcurrency(
  value: unknown = DEFAULT_PROBE_CONCURRENCY,
): number {
  const concurrency =
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_PROBE_CONCURRENCY
  ) {
    throw new ProbeConcurrencyError();
  }
  return concurrency;
}
