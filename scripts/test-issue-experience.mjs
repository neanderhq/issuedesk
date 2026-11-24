// Exercise the real built app, including persistence and accessible keyboard editing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { DEMO_EMAIL } from '../.neander/seed.mjs';

const origin = new URL(process.argv[2] || process.env.BETTER_AUTH_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Use a loopback test app');
assert.equal(origin.protocol, 'http:');
assert.ok(process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL, 'An explicitly disposable database is required');
assert.equal(process.env.DATABASE_URL, process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);
assert.ok(process.env.DEMO_OWNER_PASSWORD);
const evidence = process.env.NEANDER_ISSUE_EXPERIENCE_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const titleText = `Keyboard regression ${randomUUID()}`;
let created;
async function api(path, method = 'GET', data, status = 200) {
  const response = await context.request.fetch(new URL(path, origin).href, { method, headers: { origin: origin.origin }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
async function capture(name) {
  if (evidence) await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true, animations: 'disabled' });
}
try {
  await api('/api/auth/sign-in/email', 'POST', { email: DEMO_EMAIL, password: process.env.DEMO_OWNER_PASSWORD });
  await page.goto(new URL('/list', origin).href);
  const newIssue = page.getByRole('button', { name: 'New issue', exact: true });
  await expect(newIssue).toBeVisible();
  await expect(page.getByRole('heading', { name: 'List', exact: true })).toHaveCount(1);
  await newIssue.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  const newTitle = dialog.getByRole('textbox', { name: 'Title', exact: true });
  await expect(newTitle).toBeFocused();
  await page.keyboard.type(titleText);
  // Reach the submit action using the normal tab order, including optional fields.
  const submit = dialog.getByRole('button', { name: 'Create issue', exact: true });
  for (let step = 0; step < 30 && !await submit.evaluate(element => element === document.activeElement); step++) await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(newIssue).toBeFocused();
  created = (await api('/api/issues?q=' + encodeURIComponent(titleText))).issues.find(issue => issue.title === titleText);
  assert.ok(created, 'The keyboard-created issue must be persisted');
  await page.goto(new URL('/issue/' + created.identifier, origin).href);
  const title = page.getByRole('textbox', { name: 'Issue title', exact: true });
  await expect(title).toHaveValue(titleText);
  await title.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(title).toBeFocused();
  const shadow = await title.evaluate(element => getComputedStyle(element).boxShadow);
  assert.notEqual(shadow, 'none', 'Title editing must show a visible keyboard focus ring');
  await expect.poll(() => title.evaluate(element => getComputedStyle(element).boxShadow), {
    message: 'The keyboard focus indicator must have visible width after its transition',
  }).toMatch(/2px/);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('   ');
  await page.keyboard.press('Tab');
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  const errorId = await title.getAttribute('aria-describedby');
  assert.ok(errorId, 'Invalid input must reference its visible error');
  await expect(page.locator('#' + errorId)).toContainText('Enter an issue title');
  assert.equal((await api('/api/issues/' + created.id)).title, titleText, 'Invalid text must not replace the persisted title');
  await capture('title-validation');
  await title.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(titleText + ' reviewed');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/issues/' + created.id) && response.request().method() === 'PATCH');
  await page.keyboard.press('Enter');
  assert.equal((await saved).status(), 200);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Issue title', exact: true })).toHaveValue(titleText + ' reviewed');
  await expect(page.getByRole('textbox', { name: 'Issue title', exact: true })).toHaveAttribute('aria-invalid', 'false');
  await capture('desktop-issue');
  await page.goto(new URL('/cycles', origin).href);
  await expect(page.getByRole('heading', { name: 'Cycles', exact: true })).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 900 });
  for (const path of ['/list', '/board', '/backlog', '/my-issues', '/projects', '/cycles', '/issue/' + created.identifier]) {
    await page.goto(new URL(path, origin).href);
    if (path.startsWith('/issue/')) await expect(page.getByRole('textbox', { name: 'Issue title', exact: true })).toBeVisible();
    else if (path === '/board') await expect(page.getByRole('region', { name: /Backlog:/ })).toBeVisible();
    else if (path === '/projects') await expect(page.getByText('Product Launch', { exact: true })).toBeVisible();
    else if (path === '/cycles') await expect(page.getByRole('button', { name: 'New cycle', exact: true })).toBeEnabled();
    else await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.equal(dimensions.viewport, 375);
    assert.ok(dimensions.width <= 375, `Phone page ${path} must not overflow (${dimensions.width}px)`);
    await capture('phone-' + path.replaceAll('/', '_'));
  }
  await page.goto(new URL('/list', origin).href);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(new URL('/projects', origin).href);
  await expect(page.getByText('Product Launch', { exact: true })).toBeVisible();
  assert.deepEqual(errors, [], 'Reviewed workflows must have no browser runtime errors');
  console.log('Issue experience passed: keyboard creation/focus return, visible title focus, associated invalid-title error, unchanged persisted title after invalid input, corrected save/reload, one page heading, 375px layouts and phone navigation.');
} finally {
  if (created) {
    const current = await api('/api/issues/' + created.id);
    await api('/api/issues/' + created.id, 'DELETE', { version: current.version });
  }
  await browser.close();
}
