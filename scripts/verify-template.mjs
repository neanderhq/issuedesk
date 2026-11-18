// Checks the built image using only the verifier's disposable PostgreSQL database.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { DEMO_OWNER_ID, DEMO_EMAIL, WORKSPACE_ID, seed } from '../.neander/seed.mjs';

const exec = promisify(execFile);
const image = process.env.NEANDER_TEMPLATE_IMAGE;
const databaseUrl = process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL;
assert.ok(image, 'The shared verifier must supply the built image');
assert.ok(databaseUrl, 'An explicitly disposable test database is required');
assert.equal(process.env.DATABASE_URL, databaseUrl);
const origin = new URL(process.env.BETTER_AUTH_URL);
assert.equal(origin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
const password = process.env.DEMO_OWNER_PASSWORD;
assert.ok(password && process.env.BETTER_AUTH_SECRET);
const name = `linear-template-check-${randomUUID().slice(0, 12)}`;
const directory = await mkdtemp(join(tmpdir(), 'linear-template-'));
const bundle = join(directory, 'neander_environment');
const runtimeDatabase = new URL(databaseUrl);
if (process.platform === 'darwin' && ['localhost', '127.0.0.1'].includes(runtimeDatabase.hostname)) runtimeDatabase.hostname = 'host.docker.internal';
const environment = { DATABASE_URL: runtimeDatabase.href, BETTER_AUTH_URL: origin.origin, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, DEMO_OWNER_PASSWORD: password };
await writeFile(bundle, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o644 });
const db = new Client({ connectionString: databaseUrl });
let browser;
let connected = false;
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin.origin}/api/health`)).ok) return; } catch {}
    await delay(500);
  }
  throw new Error('Built image did not become ready within 60 seconds');
}
async function json(response, status = 200) {
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
const headers = { origin: origin.origin };
try {
  const networking = process.platform === 'linux' ? ['--network', 'host', '--env', `PORT=${origin.port || 80}`] : ['--publish', `127.0.0.1:${origin.port || 80}:8080`];
  await exec('docker', ['run', '--detach', '--name', name, '--mount', `type=bind,src=${bundle},dst=/run/secrets/neander_environment,readonly`, ...networking, image], { timeout: 60000 });
  await ready();
  await exec('python3', ['scripts/test_entrypoint.py'], { timeout: 60000 });
  await exec('python3', ['scripts/smoke.py', origin.origin], { timeout: 60000 });
  await db.connect(); connected = true;
  const credentialBefore = (await db.query('SELECT password FROM account WHERE user_id=$1', [DEMO_OWNER_ID])).rows[0].password;
  assert.deepEqual(await seed({ databaseUrl, password }), { created: false });
  await exec('pnpm', ['exec', 'playwright', 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(`${origin.origin}/api/issues`)).status(), 401);
  await page.goto(`${origin.origin}/login`);
  await expect(page.getByText('Linear', { exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(DEMO_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${origin.origin}/inbox`);
  const issues = (await json(await context.request.get(`${origin.origin}/api/issues`))).issues;
  assert.equal(issues.length, 20);
  const projects = await json(await context.request.get(`${origin.origin}/api/projects`));
  assert.equal(projects.projects[0].name, 'Product Launch');
  await page.goto(`${origin.origin}/board`);
  await expect(page.getByText('Approve launch positioning and messaging', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (process.env.NEANDER_TEMPLATE_SCREENSHOT) await page.screenshot({ path: process.env.NEANDER_TEMPLATE_SCREENSHOT, fullPage: true, animations: 'disabled' });
  const issue = issues.find(item => item.title === 'Approve launch positioning and messaging');
  const updatedTitle = `${issue.title} — edited`;
  const edited = await json(await context.request.patch(`${origin.origin}/api/issues/${issue.id}`, { headers, data: { title: updatedTitle, status: 'In Progress', version: issue.version } }));
  assert.equal(edited.title, updatedTitle);
  const removed = issues.find(item => !item.parentIssueId && item.id !== issue.id);
  await json(await context.request.delete(`${origin.origin}/api/issues/${removed.id}`, { headers, data: { version: removed.version } }));
  await seed({ databaseUrl, password: 'replacement-not-used' });
  assert.equal((await json(await context.request.get(`${origin.origin}/api/issues/${issue.id}`))).title, updatedTitle);
  assert.equal((await db.query('SELECT password FROM account WHERE user_id=$1', [DEMO_OWNER_ID])).rows[0].password, credentialBefore);
  assert.ok((await db.query('SELECT archived_at FROM issues WHERE id=$1', [removed.id])).rows[0].archived_at, 'Seed retries preserve archived sample issues');
  await exec('docker', ['restart', name], { timeout: 60000 });
  await ready();
  const persisted = await json(await context.request.get(`${origin.origin}/api/issues/${issue.id}`));
  assert.equal(persisted.title, updatedTitle);
  assert.equal(persisted.status, 'In Progress');
  await page.reload();
  await expect(page.getByText(updatedTitle, { exact: true })).toBeVisible();
  assert.deepEqual(errors, [], 'Seeded UI must have no browser runtime errors');
  console.log('Built-image verification passed: login, 20 seeded issues, Product Launch project, board rendering, persistent edit/status change, seed retry preservation and container restart.');
} catch (error) {
  const logs = await exec('docker', ['logs', '--tail', '80', name]).catch(() => ({ stdout: '', stderr: '' }));
  console.error(logs.stdout, logs.stderr);
  throw error;
} finally {
  if (browser) await browser.close();
  if (connected) {
    // The caller owns and discards this disposable database.
    await db.end();
  }
  await exec('docker', ['rm', '--force', name]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
