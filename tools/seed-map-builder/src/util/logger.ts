const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export const logger = {
  debug(...args: unknown[]) {
    if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.debug)
      console.log(`[${ts()}] [DEBUG]`, ...args);
  },
  info(...args: unknown[]) {
    if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.info)
      console.log(`[${ts()}] [INFO]`, ...args);
  },
  warn(...args: unknown[]) {
    if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.warn)
      console.warn(`[${ts()}] [WARN]`, ...args);
  },
  error(...args: unknown[]) {
    if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.error)
      console.error(`[${ts()}] [ERROR]`, ...args);
  },
};
