import { Client } from "pg";

export async function withWorkspaceLock<T>(operation: () => Promise<T>) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(914728331)");
  try {
    return await operation();
  } finally {
    await client.query("SELECT pg_advisory_unlock(914728331)");
    await client.end();
  }
}
