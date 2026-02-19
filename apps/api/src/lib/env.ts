import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const CANDIDATE_ENV_FILES = [
  join(__dirname, "../../.env"),
  join(__dirname, "../../.env.local"),
  join(__dirname, "../../../../.env"),
  join(__dirname, "../../../../.env.local"),
];

let parsedEnvCache: Record<string, string> | null = null;

function parseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const equalIndex = trimmed.indexOf("=");
  if (equalIndex <= 0) return null;

  const key = trimmed.slice(0, equalIndex).trim();
  const rawValue = trimmed.slice(equalIndex + 1).trim();
  if (!key) return null;

  let value = rawValue;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFiles() {
  const result: Record<string, string> = {};
  for (const filePath of CANDIDATE_ENV_FILES) {
    if (!existsSync(filePath)) continue;
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      result[parsed.key] = parsed.value;
    }
  }
  return result;
}

function parsedEnv() {
  if (!parsedEnvCache) {
    parsedEnvCache = loadEnvFiles();
  }
  return parsedEnvCache;
}

export function readEnvVar(key: string): string | undefined {
  const runtime = process.env[key];
  if (typeof runtime === "string" && runtime.length > 0) {
    return runtime;
  }

  const fromFile = parsedEnv()[key];
  if (typeof fromFile === "string" && fromFile.length > 0) {
    return fromFile;
  }

  return undefined;
}
