type ClientLogLevel = "info" | "warn" | "error";

export function logClientEvent(
  level: ClientLogLevel,
  event: string,
  data: Record<string, unknown> = {},
) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    service: "tunaris-web",
    ...data,
  };

  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
