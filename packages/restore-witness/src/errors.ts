export class WitnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessError';
  }
}

export function safeMessage(error: unknown): string {
  return error instanceof WitnessError ? error.message : 'Operation failed. No credentials or database output are included in this error.';
}
