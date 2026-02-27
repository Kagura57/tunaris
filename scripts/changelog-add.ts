#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHANGELOG_PATH = resolve(process.cwd(), "CHANGELOG.md");
const ENTRY_MARKER = "<!-- changelist:entries -->";
const DEFAULT_MAX_FILES = 12;

type ParsedArgs = {
  title: string;
  notes: string[];
  includeAllFiles: boolean;
};

function printHelp() {
  console.log(
    [
      "Usage:",
      "  bun run changelog:add -- \"<title>\" [--note \"...\"] [--all]",
      "",
      "Examples:",
      "  bun run changelog:add -- \"Improve autocomplete speed\"",
      "  bun run changelog:add -- \"Fix lobby start flow\" --note \"Hide non-blocking syncing errors\"",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const notes: string[] = [];
  const titleParts: string[] = [];
  let includeAllFiles = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) continue;

    if (current === "--help" || current === "-h") {
      printHelp();
      process.exit(0);
    }

    if (current === "--all") {
      includeAllFiles = true;
      continue;
    }

    if (current === "--note" || current === "-n") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --note");
      }
      notes.push(next.trim());
      index += 1;
      continue;
    }

    titleParts.push(current);
  }

  const title = titleParts.join(" ").trim();
  if (!title) {
    throw new Error("Missing changelist title");
  }

  return { title, notes, includeAllFiles };
}

function safeExec(command: string, trimOutput = true) {
  try {
    const output = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return trimOutput ? output.trim() : output;
  } catch {
    return "";
  }
}

function detectChangedFiles() {
  const porcelain = safeExec("git status --porcelain", false);
  if (porcelain) {
    const entries = porcelain
      .split("\n")
      .map((line) => line.replace(/\r/g, ""))
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const rawPath = line.slice(3).trim();
        const renamed = rawPath.includes("->");
        if (renamed) {
          const parts = rawPath.split("->");
          return parts[parts.length - 1]?.trim() ?? "";
        }
        return rawPath;
      })
      .filter((line) => line.length > 0);
    if (entries.length > 0) {
      return Array.from(new Set(entries));
    }
  }

  const commands = [
    "git diff --name-only",
    "git diff --name-only --cached",
    "git ls-files --others --exclude-standard",
    "git diff --name-only -- apps packages docs scripts .github README.md CHANGELOG.md package.json",
    "git diff --name-only --cached -- apps packages docs scripts .github README.md CHANGELOG.md package.json",
    "git ls-files --others --exclude-standard -- apps packages docs scripts .github README.md CHANGELOG.md package.json",
  ];

  const merged: string[] = [];
  for (const command of commands) {
    const output = safeExec(command);
    if (!output) continue;
    const files = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    merged.push(...files);
  }

  return Array.from(new Set(merged));
}

function ensureChangelogExists() {
  if (existsSync(CHANGELOG_PATH)) return;
  const initial = [
    "# Changelog",
    "",
    "All notable changes to this project are tracked here.",
    "",
    "## Unreleased",
    ENTRY_MARKER,
    "",
    "## Archive",
    "",
    "No released versions yet.",
    "",
  ].join("\n");
  writeFileSync(CHANGELOG_PATH, initial, "utf8");
}

function buildEntry(input: ParsedArgs, files: string[]) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  const branch = safeExec("git rev-parse --abbrev-ref HEAD") || "unknown";
  const shortSha = safeExec("git rev-parse --short HEAD") || "none";

  const renderedFiles =
    input.includeAllFiles || files.length <= DEFAULT_MAX_FILES
      ? files
      : [
          ...files.slice(0, DEFAULT_MAX_FILES),
          `... and ${files.length - DEFAULT_MAX_FILES} more`,
        ];

  const lines: string[] = [];
  lines.push(`### ${date} ${time} UTC - ${input.title}`);
  lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Base commit: \`${shortSha}\``);

  if (renderedFiles.length > 0) {
    lines.push(`- Files: ${renderedFiles.map((file) => `\`${file}\``).join(", ")}`);
  } else {
    lines.push("- Files: _(none detected)_");
  }

  if (input.notes.length > 0) {
    lines.push(`- Notes: ${input.notes.join(" | ")}`);
  }

  return lines.join("\n");
}

function insertEntry(entry: string) {
  const current = readFileSync(CHANGELOG_PATH, "utf8");

  if (current.includes(ENTRY_MARKER)) {
    const updated = current.replace(ENTRY_MARKER, `${ENTRY_MARKER}\n\n${entry}`);
    writeFileSync(CHANGELOG_PATH, updated, "utf8");
    return;
  }

  const fallback = `${current.trimEnd()}\n\n## Unreleased\n${ENTRY_MARKER}\n\n${entry}\n`;
  writeFileSync(CHANGELOG_PATH, fallback, "utf8");
}

function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    ensureChangelogExists();
    const files = detectChangedFiles();
    const entry = buildEntry(parsed, files);
    insertEntry(entry);
    console.log(`Added changelist entry: "${parsed.title}"`);
    console.log(`Updated: ${CHANGELOG_PATH}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unknown error");
    printHelp();
    process.exit(1);
  }
}

main();
