import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hasExplicitlyClearedSavedViewFilters, writeIssueFiltersToSearch } from "../components/issues/issue-filter-url.ts";

const origin = process.env.ISSUE_FILTERS_ORIGIN || "http://127.0.0.1:3000";
const originUrl = new URL(origin);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (!loopbackHosts.has(originUrl.hostname) || originUrl.protocol !== "http:") throw new Error("Issue filter checks only run against a loopback HTTP preview");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; run with node --env-file=.env.local");
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!loopbackHosts.has(databaseUrl.hostname) || process.env.DATABASE_URL !== process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL) {
  throw new Error("Issue filter checks require a loopback explicitly disposable NEANDER_TEMPLATE_TEST_DATABASE_URL equal to DATABASE_URL");
}

const email = process.env.TRACKER_TEST_EMAIL;
const password = process.env.TRACKER_TEST_PASSWORD;
if (!email || !password) throw new Error("Set TRACKER_TEST_EMAIL and TRACKER_TEST_PASSWORD for the existing local Admin account");

const filterKeys = ["q", "projectId", "status", "priority", "assigneeId", "labelId", "cycleId"];
const cookieParts = (response) => (response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""])
  .map((value) => value.split(";", 1)[0]).filter(Boolean);
let cookie = "";
let savedViewId = "";
let savedViewVersion = 0;
let failure;

async function call(path, { method = "GET", body } = {}) {
  const headers = { "x-forwarded-for": "127.0.0.1" };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers.origin = origin;
    headers["content-type"] = "application/json";
  }
  return fetch(new URL(path, origin), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual" });
}

async function read(response, expectedStatus, label) {
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus, `${label}: expected ${expectedStatus}, received ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function getIssues(filters = {}) {
  const search = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined));
  const payload = await read(await call(`/api/issues${search.size ? `?${search}` : ""}`), 200, `issues ${search.toString() || "unfiltered"}`);
  return payload.issues;
}

function assertSameIssues(actual, expected, label) {
  assert.deepEqual(actual.map(({ id }) => id).sort(), expected.map(({ id }) => id).sort(), label);
}

try {
  const loginResponse = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
  await read(loginResponse, 200, "existing Admin sign-in");
  cookie = cookieParts(loginResponse).join("; ");
  if (!cookie) throw new Error("Admin sign-in did not return a session cookie");

  const baseline = await getIssues();
  assert.ok(baseline.length, "The local sample database returned no issues");
  const issue = baseline[0];
  const checks = [];
  const checkFilter = async (label, filter, expected) => {
    assertSameIssues(await getIssues(filter), expected, `${label} filter returned an unexpected issue set`);
    checks.push(label);
  };

  const identifierQuery = issue.identifier;
  await checkFilter("identifier search", { q: identifierQuery }, baseline.filter((item) =>
    [item.identifier, item.title, item.description].some((value) => value?.toLowerCase().includes(identifierQuery.toLowerCase()))));

  const uppercaseTitle = issue.title.toUpperCase();
  await checkFilter("case-insensitive title search", { q: uppercaseTitle }, baseline.filter((item) =>
    [item.identifier, item.title, item.description].some((value) => value?.toLowerCase().includes(uppercaseTitle.toLowerCase()))));

  const describedIssue = baseline.find((item) => item.description?.trim());
  if (describedIssue) {
    const descriptionQuery = describedIssue.description.trim().slice(0, Math.min(20, describedIssue.description.trim().length));
    await checkFilter("description search", { q: descriptionQuery }, baseline.filter((item) =>
      [item.identifier, item.title, item.description].some((value) => value?.toLowerCase().includes(descriptionQuery.toLowerCase()))));
  }

  const projectIssue = baseline.find((item) => item.projectId);
  if (projectIssue) await checkFilter("project", { projectId: projectIssue.projectId }, baseline.filter((item) => item.projectId === projectIssue.projectId));
  await checkFilter("status", { status: issue.status }, baseline.filter((item) => item.status === issue.status));
  await checkFilter("priority", { priority: issue.priority }, baseline.filter((item) => item.priority === issue.priority));
  const assigneeIssue = baseline.find((item) => item.assigneeId);
  if (assigneeIssue) await checkFilter("assignee", { assigneeId: assigneeIssue.assigneeId }, baseline.filter((item) => item.assigneeId === assigneeIssue.assigneeId));
  const labelIssue = baseline.find((item) => item.labels.length);
  if (labelIssue) {
    const labelId = labelIssue.labels[0].id;
    await checkFilter("label", { labelId }, baseline.filter((item) => item.labels.some((label) => label.id === labelId)));
  }
  const cycleIssue = baseline.find((item) => item.cycleId);
  if (cycleIssue) await checkFilter("cycle", { cycleId: cycleIssue.cycleId }, baseline.filter((item) => item.cycleId === cycleIssue.cycleId));

  await checkFilter("combined status and priority", { status: issue.status, priority: issue.priority }, baseline.filter((item) => item.status === issue.status && item.priority === issue.priority));
  await read(await call(`/api/issues?q=${"x".repeat(200)}`), 200, "200-character search limit");
  await read(await call(`/api/issues?q=${"x".repeat(201)}`), 400, "201-character search rejection");

  const savedFilters = { status: issue.status, priority: issue.priority };
  const createResponse = await call("/api/saved-views", {
    method: "POST",
    body: { name: `Filter check ${randomUUID()}`, filters: savedFilters, layout: "List", shared: false },
  });
  const savedView = await read(createResponse, 201, "create temporary saved view");
  savedViewId = savedView.id;
  savedViewVersion = savedView.version;
  assert.deepEqual(savedView.filters, savedFilters, "Saved view did not preserve its filters");
  const reopened = await read(await call(`/api/saved-views/${encodeURIComponent(savedViewId)}`), 200, "reopen saved view after refresh");
  assert.deepEqual(reopened.filters, savedFilters, "Reopened saved view did not preserve its filters");
  const refreshedPage = await call(`/saved-views/${encodeURIComponent(savedViewId)}?viewFilters=cleared`);
  assert.equal(refreshedPage.status, 200, `Refresh saved view page: expected 200, received ${refreshedPage.status}`);

  const clearedSearch = new URLSearchParams("status=Done&priority=High&keep=1");
  writeIssueFiltersToSearch(clearedSearch, filterKeys, new URLSearchParams(), true);
  assert.equal(clearedSearch.get("viewFilters"), "cleared", "Clearing saved-view filters did not write the explicit URL state");
  assert.equal(clearedSearch.has("status"), false, "Cleared saved-view URL retained a filter");
  assert.equal(clearedSearch.get("keep"), "1", "Clearing filters removed unrelated URL parameters");
  assert.equal(hasExplicitlyClearedSavedViewFilters(clearedSearch, true), true, "Refresh did not recognize the cleared saved-view state");
  const changedSearch = new URLSearchParams(clearedSearch);
  writeIssueFiltersToSearch(changedSearch, filterKeys, new URLSearchParams("status=Todo"), true);
  assert.equal(changedSearch.get("viewFilters"), null, "Adding a filter did not clear the explicit empty-state marker");

  const updateResponse = await call(`/api/saved-views/${encodeURIComponent(savedViewId)}`, {
    method: "PATCH",
    body: { version: savedViewVersion, filters: {} },
  });
  const updated = await read(updateResponse, 200, "update saved-view defaults after clearing");
  savedViewVersion = updated.version;
  const refreshed = await read(await call(`/api/saved-views/${encodeURIComponent(savedViewId)}`), 200, "refresh updated saved view");
  assert.deepEqual(refreshed.filters, {}, "Updated saved-view defaults did not persist");

  console.log(`Issue filter checks passed: ${checks.join(", ")}; combined filters, saved-view reopen/update, cleared URL refresh state, and 200-character limit.`);
  if (!describedIssue) console.log("Description search check skipped: the existing sample database has no non-empty issue description.");
} catch (error) {
  failure = error;
} finally {
  if (savedViewId && cookie) {
    const deleted = await call(`/api/saved-views/${encodeURIComponent(savedViewId)}`, { method: "DELETE", body: { version: savedViewVersion } });
    const payload = await deleted.json().catch(() => ({}));
    if (deleted.status !== 200 && !failure) failure = new Error(`Clean up temporary saved view: received ${deleted.status}: ${JSON.stringify(payload)}`);
  }
  if (cookie) await call("/api/auth/sign-out", { method: "POST", body: {} });
}

if (failure) throw failure;
