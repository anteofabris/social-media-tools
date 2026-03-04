import { logger } from "./logger";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApiError extends Error {
  status?: number;
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 5, baseMs = 1000, label = "request" } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as ApiError).status;
      const retryable =
        status === 429 || (status !== undefined && status >= 500 && status < 600);

      if (!retryable || attempt === maxRetries) throw err;

      const jitter = Math.random() * 1000;
      const delay = baseMs * Math.pow(2, attempt) + jitter;
      logger.warn(
        `${label}: attempt ${attempt + 1} failed (${status}), retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw new Error("unreachable");
}
