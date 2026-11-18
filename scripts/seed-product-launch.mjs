import { Pool } from "pg";
import { seedProductLaunch } from "../server/seed-product-launch.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; pass the local .env.local file with --env-file.");
const databaseAddress = new URL(databaseUrl);
if (!(["127.0.0.1", "localhost", "::1", "[::1]"].includes(databaseAddress.hostname)) || databaseAddress.pathname !== "/neander_dev") {
  throw new Error("Refusing to seed: DATABASE_URL must point to the local neander_dev database.");
}

const workspaceArgument = process.argv.slice(2).find((argument) => argument.startsWith("--workspace-id="));
const workspaceId = workspaceArgument?.slice("--workspace-id=".length);
if (workspaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
  throw new Error("--workspace-id must be a valid UUID.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const workspaceResult = await client.query(
    `SELECT w.id, m.user_id
       FROM workspaces w
       JOIN memberships m ON m.workspace_id = w.id
      WHERE m.active = true AND m.role = 'Admin' ${workspaceId ? "AND w.id = $1" : ""}
      ORDER BY w.created_at
      LIMIT 1`,
    workspaceId ? [workspaceId] : [],
  );
  if (!workspaceResult.rows.length) throw new Error("No workspace with an active Admin was found in the local database.");
  const workspace = workspaceResult.rows[0];
  const seeded = await seedProductLaunch(client, workspace.id, workspace.user_id);
  await client.query("COMMIT");
  console.log(seeded ? "Product Launch sample data seeded." : "Product Launch sample data was already seeded; no changes made.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
