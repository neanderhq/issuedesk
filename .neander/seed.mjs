// Versioned fictional data only; never copies the original project's database.
import { pathToFileURL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Client } from 'pg';
import { seedProductLaunch } from '../server/seed-product-launch.mjs';

export const DEMO_OWNER_ID = 'template-linear-maya';
export const DEMO_EMAIL = 'maya.chen@example.invalid';
export const WORKSPACE_ID = 'a1729431-d3ef-4dc4-9a11-cdbeae856f02';

export async function seed({ databaseUrl, password }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!password || password.length < 12) throw new Error('DEMO_OWNER_PASSWORD must contain at least 12 characters');
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('template-linear-seed-v1'))");
    if ((await client.query('SELECT id FROM "user" WHERE id=$1', [DEMO_OWNER_ID])).rowCount) {
      await client.query('COMMIT');
      return { created: false };
    }
    const passwordHash = await hashPassword(password);
    await client.query('INSERT INTO "user" (id,name,email,email_verified) VALUES ($1,$2,$3,true)', [DEMO_OWNER_ID, 'Maya Chen', DEMO_EMAIL]);
    await client.query('INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ($1,$2,$3,$2,$4,NOW(),NOW())', ['template-linear-credential', DEMO_OWNER_ID, 'credential', passwordHash]);
    await client.query('INSERT INTO workspaces (id,name,issue_key_prefix) VALUES ($1,$2,$3)', [WORKSPACE_ID, 'IssueDesk', 'ID']);
    await client.query("INSERT INTO memberships (workspace_id,user_id,role,active) VALUES ($1,$2,'Admin',true)", [WORKSPACE_ID, DEMO_OWNER_ID]);
    await seedProductLaunch(client, WORKSPACE_ID, DEMO_OWNER_ID);
    await client.query('COMMIT');
    return { created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await seed({ databaseUrl: process.env.DATABASE_URL, password: process.env.DEMO_OWNER_PASSWORD });
  console.log(result.created ? 'Fictional IssueDesk workspace initialized.' : 'IssueDesk already initialized; existing data preserved.');
}
