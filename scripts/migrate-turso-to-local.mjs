// One-time migration: copy full schema + data from remote Turso into a local SQLite file.
// Usage: node --env-file-if-exists=.env scripts/migrate-turso-to-local.mjs
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const LOCAL_DB_PATH = path.join(process.cwd(), "data", "local.db");

const remoteUrl = process.env.TURSO_CONNECTION_URL;
const remoteToken = process.env.TURSO_AUTH_TOKEN;

if (!remoteUrl) {
  console.error("Missing TURSO_CONNECTION_URL");
  process.exit(1);
}

// Ensure data dir exists and start from a clean local db
fs.mkdirSync(path.dirname(LOCAL_DB_PATH), { recursive: true });
for (const f of [LOCAL_DB_PATH, `${LOCAL_DB_PATH}-shm`, `${LOCAL_DB_PATH}-wal`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

const remote = createClient({ url: remoteUrl, authToken: remoteToken });
const local = createClient({ url: `file:${LOCAL_DB_PATH}` });

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function main() {
  // 1) Pull schema objects (tables first, then indexes/triggers/views)
  const master = await remote.execute(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END`
  );

  const tables = master.rows.filter((r) => r.type === "table");
  const others = master.rows.filter((r) => r.type !== "table");

  await local.execute("PRAGMA foreign_keys = OFF");

  // 2) Create tables
  for (const t of tables) {
    await local.execute(t.sql);
  }

  // 3) Copy data table by table
  let totalRows = 0;
  for (const t of tables) {
    const name = t.tbl_name;
    const data = await remote.execute(`SELECT * FROM ${quoteIdent(name)}`);
    if (data.rows.length === 0) {
      console.log(`  ${name}: 0 rows`);
      continue;
    }
    const cols = data.columns;
    const colList = cols.map(quoteIdent).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const insertSql = `INSERT INTO ${quoteIdent(name)} (${colList}) VALUES (${placeholders})`;

    // Batch insert
    const batch = data.rows.map((row) => ({
      sql: insertSql,
      args: cols.map((c) => {
        const v = row[c];
        return v === undefined ? null : v;
      }),
    }));
    await local.batch(batch, "write");
    totalRows += data.rows.length;
    console.log(`  ${name}: ${data.rows.length} rows`);
  }

  // 4) Recreate indexes/triggers/views
  for (const o of others) {
    try {
      await local.execute(o.sql);
    } catch (e) {
      console.warn(`  skip ${o.type} ${o.name}: ${e.message}`);
    }
  }

  await local.execute("PRAGMA foreign_keys = ON");

  console.log(`\nDone. Copied ${tables.length} tables, ${totalRows} rows total.`);
  console.log(`Local DB: ${LOCAL_DB_PATH}`);
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
