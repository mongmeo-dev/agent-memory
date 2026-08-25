#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Pool } from "pg";

export async function runSyncMigration(
  databaseUrl: string,
  migrationPath = fileURLToPath(new URL("../migrations/001-sync.sql", import.meta.url)),
): Promise<void> {
  const sql = await readFile(migrationPath, "utf8");
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");
  await runSyncMigration(databaseUrl, process.env.AGENTS_MEMORY_SYNC_MIGRATION);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
