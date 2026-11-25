// Run against migrated disposable PostgreSQL; all fixtures roll back, including on failure.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

assert.ok(process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL, 'An explicitly disposable database is required');
assert.equal(process.env.DATABASE_URL, process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);
const database = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname), 'Use a loopback test database');
const db = new Client({ connectionString: database.href });
const workspace = randomUUID();
const otherWorkspace = randomUUID();
const project = randomUUID();
const issue = randomUUID();
const label = randomUUID();
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)', [workspace, 'Fictional cursor regression', otherWorkspace, 'Fictional unchanged workspace']);
  await db.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [project, workspace, 'Fictional launch']);
  await db.query('INSERT INTO issues (id, workspace_id, issue_number, title, project_id) VALUES ($1, $2, 1, $3, $4)', [issue, workspace, 'Review launch readiness', project]);
  const cursor = async () => Number((await db.query('SELECT cursor FROM workspace_change_cursors WHERE workspace_id = $1', [workspace])).rows[0]?.cursor);
  const beforeEdit = await cursor();
  await db.query('UPDATE issues SET title = $1 WHERE id = $2', ['Review launch readiness verified', issue]);
  assert.ok(await cursor() > beforeEdit, 'Normal issue edits must still advance the cursor');
  await db.query('INSERT INTO labels (id, workspace_id, name, color) VALUES ($1, $2, $3, $4)', [label, workspace, 'Launch', '#3355ff']);
  const beforeLabel = await cursor();
  await db.query('INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)', [issue, label]);
  assert.ok(await cursor() > beforeLabel, 'Issue-owned changes must still advance the cursor');
  const beforeDelete = await cursor();
  await db.query('DELETE FROM issues WHERE id = $1', [issue]);
  assert.ok(await cursor() > beforeDelete, 'Deleting an issue from a surviving workspace must advance the cursor');
  // Keep real workspace-owned and issue-owned rows present during the cascade.
  await db.query('INSERT INTO issues (id, workspace_id, issue_number, title, project_id) VALUES ($1, $2, 2, $3, $4)', [issue, workspace, 'Fictional cascade fixture', project]);
  await db.query('INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)', [issue, label]);
  await db.query('INSERT INTO comments (workspace_id, issue_id, body) VALUES ($1, $2, $3)', [workspace, issue, 'The launch checklist is ready for review.']);
  await db.query('DELETE FROM workspaces WHERE id = $1', [workspace]);
  assert.equal((await db.query('SELECT 1 FROM workspace_change_cursors WHERE workspace_id = $1', [workspace])).rowCount, 0, 'Deleting a workspace must not recreate its change cursor');
  assert.equal((await db.query('SELECT 1 FROM issues WHERE workspace_id = $1', [workspace])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM projects WHERE workspace_id = $1', [workspace])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM workspaces WHERE id = $1', [otherWorkspace])).rowCount, 1, 'Other workspaces must remain intact');
  assert.equal((await db.query('SELECT 1 FROM workspace_change_cursors WHERE workspace_id = $1', [otherWorkspace])).rowCount, 0, 'Other workspace cursors must not change');
  console.log('Workspace cursor regression passed: normal edits/deletes, issue-owned changes, workspace cascade and workspace isolation.');
} finally {
  await db.query('ROLLBACK');
  await db.end();
}
