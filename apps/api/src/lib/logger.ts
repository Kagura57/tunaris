type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function readLogLevel(): LogLevel {
  const defaultLevel = process.env.NODE_ENV === "test" ? "warn" : "info";
  const raw = (process.env.LOG_LEVEL ?? defaultLevel).toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

const ACTIVE_LEVEL = readLogLevel();

function shouldLog(level: LogLevel) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[ACTIVE_LEVEL];
}

export function logEvent(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
  if (!shouldLog(level)) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    service: "tunaris-api",
    ...data,
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
