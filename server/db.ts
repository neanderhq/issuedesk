import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
let database: NodePgDatabase<typeof schema> | undefined;
// Lazy: builds do not need credentials or a live database.
export function getDb() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!database) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000 });
    // Idle clients can disappear during database recovery. The pool replaces them.
    // Logging the pg Client/Error object can expose connection/session data.
    pool.on("error", () => console.error("[database] idle connection lost"));
    database = drizzle(pool, { schema });
  }
  return database;
}
