import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = join(__dirname, "schema.sql");

export async function runMigrations() {
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

if (import.meta.main) {
  runMigrations()
    .then(() => {
      console.log("Database schema applied successfully.");
    })
    .catch((error: unknown) => {
      console.error("Migration failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
