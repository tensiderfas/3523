import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '@/db/schema';
import path from 'node:path';

// Singleton pattern — prevents connection accumulation on each request in Next.js
const globalForDb = globalThis as unknown as {
  _tursoClient: ReturnType<typeof createClient> | undefined;
  _drizzleDb: ReturnType<typeof drizzle> | undefined;
};

// Resolve the database connection.
// Default: a local SQLite file stored inside the project (data/local.db).
// This keeps the app fully self-contained with no external database service.
// You can still point at a remote libSQL/Turso instance by setting
// TURSO_CONNECTION_URL to a non-file URL (e.g. libsql://...).
function resolveDbUrl() {
  const configured = process.env.TURSO_CONNECTION_URL;
  if (configured && configured.startsWith('file:')) {
    return { url: configured, authToken: undefined as string | undefined };
  }
  if (configured && /^(libsql|wss|ws|https?):\/\//.test(configured)) {
    return { url: configured, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  // Fallback to the bundled local SQLite file.
  const localPath = path.join(process.cwd(), 'data', 'local.db');
  return { url: `file:${localPath}`, authToken: undefined as string | undefined };
}

function getClient() {
  if (!globalForDb._tursoClient) {
    const { url, authToken } = resolveDbUrl();
    globalForDb._tursoClient = createClient({ url, authToken });
  }
  return globalForDb._tursoClient;
}

function getDb() {
  if (!globalForDb._drizzleDb) {
    globalForDb._drizzleDb = drizzle(getClient(), { schema });
  }
  return globalForDb._drizzleDb;
}

export const db = getDb();

export type Database = typeof db;
