import { sleep } from "./backoff";
import { logger } from "./logger";

export function isInSleepWindow(): boolean {
  const hour = new Date().getHours();
  return hour >= 2 && hour < 8;
}

export async function waitForSleepWindowEnd(): Promise<void> {
  if (!isInSleepWindow()) return;
  logger.info("Inside sleep window (02:00–08:00). Pausing until 08:00...");
  while (isInSleepWindow()) {
    await sleep(60_000);
  }
  logger.info("Sleep window ended. Resuming.");
}

/**
 * Concurrency limiter — drop-in replacement for p-limit (which is ESM-only).
 */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            if (queue.length > 0) queue.shift()!();
          });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}
