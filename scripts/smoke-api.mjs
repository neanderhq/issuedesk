import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const origin = process.argv[2] || "http://127.0.0.1:3000";
const dateRangeError = "Date must be between 1900-01-01 and 2100-12-31";
const originUrl = new URL(origin);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (!loopbackHosts.has(originUrl.hostname) || originUrl.protocol !== "http:") throw new Error("API smoke only runs against a loopback HTTP preview");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; run with node --env-file=.env.local");
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!loopbackHosts.has(databaseUrl.hostname) || process.env.DATABASE_URL !== process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL) {
  throw new Error("API smoke requires a loopback explicitly disposable NEANDER_TEMPLATE_TEST_DATABASE_URL equal to DATABASE_URL");
}

const runId = randomUUID();
const emailPrefix = `phase2-smoke-${runId}`;
const adminEmail = `${emailPrefix}-admin@example.invalid`;
const memberEmail = `${emailPrefix}-member@example.invalid`;
const adminPassword = `Admin-${randomUUID()}-${randomUUID()}`;
const memberPassword = `Member-${randomUUID()}-${randomUUID()}`;
const issueTitlePrefix = `API smoke ${runId}`;
const ipAddress = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
const createdUserIds = new Set();
const createdInvitationIds = new Set();
const createdIssueIds = new Set();
const createdProjectIds = new Set();
const createdCycleIds = new Set();
const db = new Client({ connectionString: process.env.DATABASE_URL });
let databaseConnected = false;
let workspaceId;
let adminId;
let memberId;
let memberMembershipId;
let adminCookie = "";
let memberCookie = "";
let bootstrapCreated = false;
let memberRemoved = false;
let cleanupError;

function cookieFrom(response) {
  const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
  return cookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function call(path, { method = "GET", body, cookie } = {}) {
  const headers = { "x-forwarded-for": ipAddress };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers.origin = origin;
    headers["content-type"] = "application/json";
  }
  return fetch(new URL(path, origin), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
}

async function uploadAttachment(issueId, cookie, fileName, bytes, contentType = "application/octet-stream", requestOrigin = origin) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), fileName);
  const headers = { "x-forwarded-for": ipAddress, origin: requestOrigin };
  if (cookie) headers.cookie = cookie;
  return fetch(new URL(`/api/issues/${encodeURIComponent(issueId)}/attachments`, origin), {
    method: "POST",
    headers,
    body: form,
    redirect: "manual",
  });
}

async function uploadIssueCsv(action, cookie, fileName, content, contentType = "text/csv") {
  const form = new FormData();
  form.append("file", new Blob([content], { type: contentType }), fileName);
  const headers = { "x-forwarded-for": ipAddress, origin };
  if (cookie) headers.cookie = cookie;
  return fetch(new URL(`/api/issues/csv/${action}`, origin), { method: "POST", headers, body: form, redirect: "manual" });
}

async function expectStatus(response, expected, label) {
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${label}: expected ${expected}, received ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function expectDateRangeError(response, label) {
  const payload = await expectStatus(response, 400, label);
  assert.equal(payload.error, dateRangeError, `${label}: did not return the required date-range message`);
  return payload;
}

async function issueCreate(cookie, title, additional = {}) {
  const response = await call("/api/issues", { method: "POST", cookie, body: { title, ...additional } });
  const result = await expectStatus(response, 201, `create issue ${title}`);
  assert.ok(result.id && result.issueNumber && result.identifier, "Created issue did not return its generated identifier");
  createdIssueIds.add(result.id);
  return result;
}

async function cycleCreate(cookie, name, startDate, endDate) {
  const response = await call("/api/cycles", {
    method: "POST",
    cookie,
    body: { name, startDate, ...(endDate ? { endDate } : {}) },
  });
  const result = await expectStatus(response, 201, `create cycle ${name}`);
  assert.ok(result.id && result.version === 1, "Created cycle did not return its versioned record");
  createdCycleIds.add(result.id);
  return result;
}

async function cleanup() {
  try {
    if (adminCookie && memberMembershipId && !memberRemoved) {
      const removed = await call(`/api/settings/members/${memberMembershipId}`, { method: "DELETE", cookie: adminCookie, body: {} });
      if ([200, 404].includes(removed.status)) memberRemoved = true;
    }
    if (!databaseConnected && (createdUserIds.size || createdInvitationIds.size || createdIssueIds.size || createdProjectIds.size || createdCycleIds.size || bootstrapCreated)) {
      await db.connect();
      databaseConnected = true;
    }
    if (databaseConnected) {
      if (workspaceId && memberId) {
        await db.query("DELETE FROM issues WHERE workspace_id = $1 AND creator_id = $2 AND title LIKE $3", [workspaceId, memberId, `${issueTitlePrefix}%`]);
      }
      if (createdIssueIds.size && workspaceId) {
        await db.query("DELETE FROM issues WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, [...createdIssueIds]]);
      }
      if (createdProjectIds.size && workspaceId) {
        await db.query("DELETE FROM projects WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, [...createdProjectIds]]);
      }
      if (createdCycleIds.size && workspaceId) {
        await db.query("DELETE FROM cycles WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, [...createdCycleIds]]);
      }
      if (createdInvitationIds.size) await db.query("DELETE FROM invitations WHERE id = ANY($1::uuid[])", [[...createdInvitationIds]]);
      if (createdUserIds.size) await db.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [[...createdUserIds]]);
      if (bootstrapCreated && workspaceId) {
        await db.query("DELETE FROM workspaces WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = $1)", [workspaceId]);
      }
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    if (databaseConnected) await db.end();
  }
}

try {
  await expectStatus(await call("/api/issues"), 401, "signed-out issue list");
  await expectStatus(await call("/api/issues", { method: "POST", body: { title: "Signed-out write" } }), 401, "signed-out issue create");
  const registration = await expectStatus(await call("/api/registration-status"), 200, "registration status");
  if (registration.bootstrapAllowed) {
    bootstrapCreated = true;
    const response = await call("/api/signup", { method: "POST", body: { name: "API Smoke Admin", email: adminEmail, password: adminPassword } });
    const created = await expectStatus(response, 200, "temporary Admin bootstrap");
    adminCookie = cookieFrom(response);
    createdUserIds.add(created.user.id);
  } else {
    if (!process.env.SMOKE_API_ADMIN_EMAIL || !process.env.SMOKE_API_ADMIN_PASSWORD) {
      console.log("Signed-out checks passed. Set SMOKE_API_ADMIN_EMAIL and SMOKE_API_ADMIN_PASSWORD to run workspace API checks without modifying a pre-existing workspace.");
      process.exitCode = 2;
    } else {
      const loginResponse = await call("/api/auth/sign-in/email", { method: "POST", body: { email: process.env.SMOKE_API_ADMIN_EMAIL, password: process.env.SMOKE_API_ADMIN_PASSWORD } });
      await expectStatus(loginResponse, 200, "existing Admin sign-in");
      adminCookie = cookieFrom(loginResponse);
    }
  }

  if (adminCookie) {
    const me = await expectStatus(await call("/api/me", { cookie: adminCookie }), 200, "Admin session");
    workspaceId = me.workspace.id;
    adminId = me.user.id;
    if (!databaseConnected) {
      await db.connect();
      databaseConnected = true;
    }
    const createdCycle = await db.query(
      "INSERT INTO cycles (workspace_id, name, goal, status, start_date, end_date) VALUES ($1, $2, $3, 'Upcoming', CURRENT_DATE, CURRENT_DATE + 14) RETURNING id, version",
      [workspaceId, `${issueTitlePrefix} cycle`, "Initial smoke goal"],
    );
    const smokeCycle = createdCycle.rows[0];
    createdCycleIds.add(smokeCycle.id);
    const invitationResponse = await call("/api/settings/invitations", { method: "POST", cookie: adminCookie, body: { email: memberEmail, role: "Member" } });
    const invitationPayload = await expectStatus(invitationResponse, 201, "temporary Member invitation");
    createdInvitationIds.add(invitationPayload.invitation.id);
    const invitationToken = new URL(invitationPayload.inviteUrl).searchParams.get("token");
    assert.ok(invitationToken, "Invitation did not include a token");
    const signupResponse = await call("/api/signup", { method: "POST", body: { name: "API Smoke Member", email: memberEmail, password: memberPassword, invitationToken } });
    const memberSignup = await expectStatus(signupResponse, 200, "temporary Member signup");
    memberCookie = cookieFrom(signupResponse);
    memberId = memberSignup.user.id;
    createdUserIds.add(memberId);
    const memberList = await expectStatus(await call("/api/settings/members", { cookie: adminCookie }), 200, "workspace members");
    const memberRecord = memberList.members.find((record) => record.userId === memberId);
    assert.ok(memberRecord, "New Member was not listed");
    memberMembershipId = memberRecord.id;

    const attachmentIssue = await issueCreate(memberCookie, `${issueTitlePrefix} attachments`);
    const attachmentContent = Buffer.from("Private attachment smoke test\n", "utf8");
    const uploadedAttachment = await expectStatus(await uploadAttachment(attachmentIssue.id, memberCookie, "notes.txt", attachmentContent, "text/plain"), 201, "allowed text attachment upload");
    assert.equal(uploadedAttachment.attachment.fileName, "notes.txt");
    assert.equal(uploadedAttachment.attachment.size, attachmentContent.length);
    const attachmentUrl = `/api/attachments/${uploadedAttachment.attachment.id}`;
    const attachmentDownload = await call(attachmentUrl, { cookie: memberCookie });
    assert.equal(attachmentDownload.status, 200, "authenticated attachment download failed");
    assert.equal(Buffer.from(await attachmentDownload.arrayBuffer()).toString("utf8"), attachmentContent.toString("utf8"));
    assert.match(attachmentDownload.headers.get("content-disposition") ?? "", /^attachment;/i);
    assert.equal(attachmentDownload.headers.get("x-content-type-options"), "nosniff");
    assert.match(attachmentDownload.headers.get("cache-control") ?? "", /private.*no-store/i);
    await expectStatus(await call(attachmentUrl), 401, "signed-out attachment download");
    await db.query("UPDATE memberships SET active = false WHERE id = $1", [memberMembershipId]);
    try {
      await expectStatus(await call(attachmentUrl, { cookie: memberCookie }), 403, "inactive Member attachment download");
    } finally {
      await db.query("UPDATE memberships SET active = true WHERE id = $1", [memberMembershipId]);
    }
    await expectStatus(await uploadAttachment(attachmentIssue.id, memberCookie, "bad-origin.txt", Buffer.from("Denied origin"), "text/plain", "http://attacker.invalid"), 403, "multipart request Origin enforcement");

    const listedAttachmentsResponse = await call(`/api/issues/${attachmentIssue.id}/attachments`, { cookie: memberCookie });
    const listedAttachments = await expectStatus(listedAttachmentsResponse, 200, "issue attachment list");
    assert.ok(listedAttachments.attachments.some(({ id, uploaderName }) => id === uploadedAttachment.attachment.id && uploaderName === "API Smoke Member"));
    assert.match(listedAttachmentsResponse.headers.get("cache-control") ?? "", /private.*no-store/i);
    const attachmentActivity = await expectStatus(await call(`/api/issues/${attachmentIssue.id}/activity`, { cookie: memberCookie }), 200, "attachment add activity");
    assert.ok(attachmentActivity.activity.some(({ action }) => action === "attachment_added"), "Attachment upload did not create activity");

    const oversizedAttachment = await uploadAttachment(attachmentIssue.id, memberCookie, "large.txt", Buffer.alloc(6 * 1024 * 1024, 97), "text/plain");
    await expectStatus(oversizedAttachment, 413, "6 MB attachment rejected");
    const svgResponse = await uploadAttachment(attachmentIssue.id, memberCookie, "vector.png", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), "image/png");
    const svgRejected = await expectStatus(svgResponse, 415, "SVG attachment rejected");
    assert.match(svgRejected.error, /SVG files are not allowed/i);
    const executableResponse = await uploadAttachment(attachmentIssue.id, memberCookie, "binary.txt", Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "text/plain");
    const executableRejected = await expectStatus(executableResponse, 415, "executable content rejected");
    assert.match(executableRejected.error, /Executable files are not allowed/i);
    const htmlResponse = await uploadAttachment(attachmentIssue.id, memberCookie, "renamed.png", Buffer.from("<!doctype html><html><body>not an image</body></html>"), "image/png");
    const htmlRejected = await expectStatus(htmlResponse, 415, "HTML content renamed to PNG rejected");
    assert.match(htmlRejected.error, /HTML files are not allowed/i);

    const limitedAttachmentIssue = await issueCreate(memberCookie, `${issueTitlePrefix} attachment limit`);
    for (let index = 1; index <= 10; index += 1) {
      await expectStatus(await uploadAttachment(limitedAttachmentIssue.id, memberCookie, `note-${index}.txt`, Buffer.from(`Attachment ${index}`), "text/plain"), 201, `attachment ${index} of 10`);
    }
    const eleventhAttachment = await expectStatus(await uploadAttachment(limitedAttachmentIssue.id, memberCookie, "note-11.txt", Buffer.from("Too many attachments"), "text/plain"), 400, "11th attachment rejected");
    assert.match(eleventhAttachment.error, /at most 10 attachments/i);

    const adminAttachment = await expectStatus(await uploadAttachment(attachmentIssue.id, adminCookie, "admin-note.txt", Buffer.from("Admin-owned attachment"), "text/plain"), 201, "Admin attachment upload");
    const forbiddenDelete = await expectStatus(await call(`/api/attachments/${adminAttachment.attachment.id}`, { method: "DELETE", cookie: memberCookie, body: {} }), 403, "non-uploader attachment delete rejected");
    assert.match(forbiddenDelete.error, /uploader or an Admin/i);
    await expectStatus(await call(`/api/attachments/${adminAttachment.attachment.id}`, { method: "DELETE", cookie: adminCookie, body: {} }), 200, "Admin attachment delete");
    const activityAfterRemoval = await expectStatus(await call(`/api/issues/${attachmentIssue.id}/activity`, { cookie: memberCookie }), 200, "attachment remove activity");
    assert.ok(activityAfterRemoval.activity.some(({ action }) => action === "attachment_removed"), "Attachment deletion did not create activity");

    const archiveResponse = await call(`/api/issues/${attachmentIssue.id}`, { method: "DELETE", cookie: memberCookie, body: { version: attachmentIssue.version } });
    const archivedAttachmentIssue = await expectStatus(archiveResponse, 200, "archive issue with attachment");
    const archivedAttachmentDownload = await call(attachmentUrl, { cookie: memberCookie });
    assert.equal(archivedAttachmentDownload.status, 200, "Attachment was not available while its issue was archived");
    await expectStatus(await call(`/api/issues/${attachmentIssue.id}/restore`, { method: "POST", cookie: memberCookie, body: { version: archivedAttachmentIssue.version } }), 200, "restore issue with attachment");
    const restoredAttachmentDownload = await call(attachmentUrl, { cookie: memberCookie });
    assert.equal(restoredAttachmentDownload.status, 200, "Attachment was not available after its issue was restored");

    const csvSourceIssue = await issueCreate(memberCookie, `${issueTitlePrefix} CSV round trip`, {
      description: 'A quoted "detail", with a second line.\nLine two.',
      status: "In Progress",
      priority: "High",
      assigneeId: memberId,
      dueDate: "2026-12-31",
      estimate: 8,
    });
    const csvExportResponse = await call(`/api/issues/csv/export?q=${encodeURIComponent(csvSourceIssue.title)}`, { cookie: memberCookie });
    assert.equal(csvExportResponse.status, 200, "filtered issue CSV export failed");
    assert.match(csvExportResponse.headers.get("content-type") ?? "", /text\/csv/i);
    const exportedCsv = await csvExportResponse.text();
    const csvPreview = await expectStatus(await uploadIssueCsv("preview", memberCookie, "issues.csv", exportedCsv), 200, "issue CSV preview");
    assert.equal(csvPreview.validCount, 1, "CSV round-trip preview did not contain exactly one valid row");
    assert.equal(csvPreview.skippedCount, 0, "CSV round-trip preview unexpectedly rejected a row");
    const csvImport = await expectStatus(await uploadIssueCsv("import", memberCookie, "issues.csv", exportedCsv), 200, "issue CSV import");
    assert.equal(csvImport.importedCount, 1, "CSV round-trip did not import one issue");
    assert.equal(csvImport.skippedCount, 0, "CSV round-trip unexpectedly skipped a row");
    const csvImportedIssue = await expectStatus(await call(`/api/issues/${encodeURIComponent(csvImport.importedRows[0].identifier)}`, { cookie: memberCookie }), 200, "read imported CSV issue");
    assert.equal(csvImportedIssue.title, csvSourceIssue.title, "CSV round-trip changed the title");
    assert.equal(csvImportedIssue.description, csvSourceIssue.description, "CSV round-trip changed the description");
    assert.equal(csvImportedIssue.status, csvSourceIssue.status, "CSV round-trip changed the status");
    assert.equal(csvImportedIssue.priority, csvSourceIssue.priority, "CSV round-trip changed the priority");
    assert.equal(csvImportedIssue.assigneeId, csvSourceIssue.assigneeId, "CSV round-trip changed the assignee");
    assert.equal(csvImportedIssue.dueDate, csvSourceIssue.dueDate, "CSV round-trip changed the due date");
    assert.equal(csvImportedIssue.estimate, csvSourceIssue.estimate, "CSV round-trip changed the estimate");

    const unsupportedHeaderCsv = [
      " TITLE , ASSIGNEE , Unknown Field ",
      `${issueTitlePrefix} CSV unsupported headers,ignored assignee,ignored field`,
    ].join("\r\n");
    const expectedUnsupportedHeaderWarnings = [
      'Column "assignee" is not supported and will be ignored. Supported columns: identifier, title, description, status, priority, assignee email, labels, project, milestone, cycle, due date, estimate, parent identifier, created, updated.',
      'Column "unknown field" is not supported and will be ignored. Supported columns: identifier, title, description, status, priority, assignee email, labels, project, milestone, cycle, due date, estimate, parent identifier, created, updated.',
    ];
    const unsupportedHeaderPreview = await expectStatus(await uploadIssueCsv("preview", memberCookie, "unsupported-headers.csv", unsupportedHeaderCsv), 200, "unsupported CSV headers preview");
    assert.deepEqual(unsupportedHeaderPreview.warnings, expectedUnsupportedHeaderWarnings, "CSV preview did not report every unsupported header");
    assert.equal(unsupportedHeaderPreview.validCount, 1, "Unsupported CSV headers made the valid row unimportable");
    const unsupportedHeaderImport = await expectStatus(await uploadIssueCsv("import", memberCookie, "unsupported-headers.csv", unsupportedHeaderCsv), 200, "unsupported CSV headers import");
    assert.deepEqual(unsupportedHeaderImport.warnings, expectedUnsupportedHeaderWarnings, "CSV import did not report every unsupported header");
    assert.equal(unsupportedHeaderImport.importedCount, 1, "CSV import did not import the row with unsupported headers");

    const invalidCsv = [
      "identifier,title,description,status,priority,assignee email,labels,project,milestone,cycle,due date,estimate,parent identifier,created,updated",
      ",,Needs review,Unknown status,Unknown priority,missing-member@example.invalid,,,,,2026-02-30,not-a-number,,,",
    ].join("\r\n");
    const invalidCsvPreview = await expectStatus(await uploadIssueCsv("preview", memberCookie, "invalid-issues.csv", invalidCsv), 200, "invalid issue CSV preview");
    assert.equal(invalidCsvPreview.rows.length, 1, "Invalid CSV preview did not return its data row");
    assert.equal(invalidCsvPreview.rows[0].rowNumber, 2, "Invalid CSV errors did not report spreadsheet row 2");
    const invalidColumns = new Set(invalidCsvPreview.rows[0].errors.map(({ column }) => column));
    assert.deepEqual([...invalidColumns].sort(), ["assignee email", "due date", "estimate", "priority", "status", "title"].sort(), "Invalid CSV did not report all six required row and column errors");

    const csvDateAndDefaults = [
      "title,status,priority,due date",
      `${issueTitlePrefix} CSV date before limit,Backlog,No priority,1899-12-31`,
      `${issueTitlePrefix} CSV date after limit,Backlog,No priority,2101-01-01`,
      `${issueTitlePrefix} CSV defaults,,,2026-06-30`,
    ].join("\r\n");
    const csvDateAndDefaultsPreview = await expectStatus(await uploadIssueCsv("preview", memberCookie, "date-and-defaults.csv", csvDateAndDefaults), 200, "CSV date range and defaults preview");
    assert.equal(csvDateAndDefaultsPreview.rows.length, 3, "CSV preview did not return every date and defaults row");
    assert.equal(csvDateAndDefaultsPreview.validCount, 1, "CSV preview did not keep the valid defaults row ready to import");
    assert.equal(csvDateAndDefaultsPreview.skippedCount, 2, "CSV preview did not flag both out-of-range dates");
    for (const rowIndex of [0, 1]) {
      assert.ok(csvDateAndDefaultsPreview.rows[rowIndex].errors.some(({ column, message }) => column === "due date" && message === "Date must be between 1900-01-01 and 2100-12-31"), "CSV preview did not report the out-of-range date on its row");
    }
    const csvDefaultsPreviewRow = csvDateAndDefaultsPreview.rows[2];
    assert.equal(csvDefaultsPreviewRow.values.status, "Backlog", "CSV preview did not show the default Backlog status");
    assert.equal(csvDefaultsPreviewRow.values.priority, "No priority", "CSV preview did not show the default no-priority value");
    const csvDateAndDefaultsImport = await expectStatus(await uploadIssueCsv("import", memberCookie, "date-and-defaults.csv", csvDateAndDefaults), 200, "CSV date range and defaults import");
    assert.equal(csvDateAndDefaultsImport.importedCount, 1, "CSV import did not import the valid row alongside invalid date rows");
    assert.equal(csvDateAndDefaultsImport.skippedCount, 2, "CSV import did not skip both out-of-range date rows");
    const csvDefaultsIssue = await expectStatus(await call(`/api/issues/${encodeURIComponent(csvDateAndDefaultsImport.importedRows[0].identifier)}`, { cookie: memberCookie }), 200, "read CSV defaults issue");
    assert.equal(csvDefaultsIssue.status, "Backlog", "CSV import did not default an empty status to Backlog");
    assert.equal(csvDefaultsIssue.priority, "No priority", "CSV import did not default an empty priority to no priority");

    const notificationIssue = await issueCreate(adminCookie, `${issueTitlePrefix} assigned notification`, { assigneeId: memberId, description: `Please review this with @${memberSignup.user.name}.` });
    const memberInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "member notification inbox");
    assert.ok(memberInbox.notifications.some((notification) => notification.issueId === notificationIssue.id && notification.type === "assigned"), "Assignment did not create a notification for the assignee");
    assert.ok(memberInbox.notifications.some((notification) => notification.issueId === notificationIssue.id && notification.type === "mentioned" && notification.payload.source === "description"), "Description mention did not create a notification");
    await expectStatus(await call(`/api/issues/${notificationIssue.id}/comments`, { method: "POST", cookie: adminCookie, body: { body: `Please take a look, @${memberSignup.user.name}.`, mentionedUserIds: [memberId] } }), 201, "comment mention notification");
    const inboxAfterMention = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox after comment mention");
    assert.ok(inboxAfterMention.notifications.some((notification) => notification.issueId === notificationIssue.id && notification.type === "mentioned" && notification.payload.source === "comment" && notification.payload.commentId), "Comment mention did not create its notification");
    const followedIssue = await issueCreate(adminCookie, `${issueTitlePrefix} followed activity`);
    await expectStatus(await call(`/api/issues/${followedIssue.id}/follow`, { method: "POST", cookie: memberCookie, body: {} }), 200, "follow issue for activity notifications");
    const followBaseline = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox before followed activity");
    const followBaselineIds = new Set(followBaseline.notifications.map((notification) => notification.id));
    let followedCurrent = await expectStatus(await call(`/api/issues/${followedIssue.id}`, { cookie: adminCookie }), 200, "followed issue before activity");
    await expectStatus(await call(`/api/issues/${followedIssue.id}`, { method: "PATCH", cookie: adminCookie, body: { status: "Todo", version: followedCurrent.version } }), 200, "followed issue status activity");
    await expectStatus(await call(`/api/issues/${followedIssue.id}/comments`, { method: "POST", cookie: adminCookie, body: { body: "A teammate left a comment" } }), 201, "followed issue comment activity");
    const followedInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox after followed issue activity");
    const followedEvents = followedInbox.notifications.filter((notification) => notification.issueId === followedIssue.id && !followBaselineIds.has(notification.id));
    assert.ok(followedEvents.some((notification) => notification.type === "activity" && notification.payload.field === "status"), "Status change on a followed issue did not notify its follower");
    assert.ok(followedEvents.some((notification) => notification.type === "activity" && notification.payload.action === "commented" && notification.payload.source === "comment"), "Comment on a followed issue did not notify its follower");
    const reorderFollowerIssue = await issueCreate(adminCookie, `${issueTitlePrefix} followed status move`, { status: "Todo" });
    const reorderSiblingIssue = await issueCreate(adminCookie, `${issueTitlePrefix} reorder sibling`, { status: "Backlog" });
    await expectStatus(await call(`/api/issues/${reorderFollowerIssue.id}/follow`, { method: "POST", cookie: memberCookie, body: {} }), 200, "follow issue for reorder notifications");
    const beforeStatusMoveInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox before status-changing move");
    const beforeStatusMoveIds = new Set(beforeStatusMoveInbox.notifications.map((notification) => notification.id));
    const beforeStatusMoveActivity = await expectStatus(await call(`/api/issues/${reorderFollowerIssue.id}/activity`, { cookie: memberCookie }), 200, "activity before status-changing move");
    const movedIssue = await expectStatus(await call(`/api/issues/${reorderFollowerIssue.id}/position`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { version: reorderFollowerIssue.version, status: "Backlog", placement: "bottom" },
    }), 200, "move followed issue to another status");
    assert.equal(movedIssue.status, "Backlog", "Status-changing move did not update the issue status");
    const afterStatusMoveInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox after status-changing move");
    const statusMoveNotifications = afterStatusMoveInbox.notifications.filter((notification) => notification.issueId === reorderFollowerIssue.id && !beforeStatusMoveIds.has(notification.id));
    assert.equal(statusMoveNotifications.length, 1, "Status-changing move did not create exactly one follower notification");
    assert.equal(statusMoveNotifications[0].type, "activity", "Status-changing move created an unexpected notification type");
    assert.equal(statusMoveNotifications[0].payload.action, "updated", "Status-changing move notification did not record an update");
    assert.equal(statusMoveNotifications[0].payload.field, "status", "Status-changing move notification did not record the status field");
    const afterStatusMoveActivity = await expectStatus(await call(`/api/issues/${reorderFollowerIssue.id}/activity`, { cookie: memberCookie }), 200, "activity after status-changing move");
    const statusMoveActivities = afterStatusMoveActivity.activity.filter((entry) => !beforeStatusMoveActivity.activity.some((previous) => previous.id === entry.id));
    assert.equal(statusMoveActivities.length, 1, "Status-changing move did not create exactly one activity entry");
    assert.equal(statusMoveActivities[0].action, "updated", "Status-changing move activity was not recorded as an update");
    assert.equal(statusMoveActivities[0].field, "status", "Status-changing move activity did not record the status field");
    assert.equal(statusMoveActivities[0].previousValue, "Todo", "Status-changing move activity did not preserve the old status");
    assert.equal(statusMoveActivities[0].nextValue, "Backlog", "Status-changing move activity did not preserve the new status");
    const beforeSameStatusInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox before same-status reorder");
    const beforeSameStatusIds = new Set(beforeSameStatusInbox.notifications.map((notification) => notification.id));
    const beforeSiblingActivity = await expectStatus(await call(`/api/issues/${reorderSiblingIssue.id}/activity`, { cookie: memberCookie }), 200, "sibling activity before same-status reorder");
    const reorderedIssue = await expectStatus(await call(`/api/issues/${reorderFollowerIssue.id}/position`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { version: movedIssue.version, status: "Backlog", placement: "before", relativeIssueId: reorderSiblingIssue.id },
    }), 200, "reorder followed issue within its status");
    assert.equal(reorderedIssue.status, "Backlog", "Same-status reorder unexpectedly changed the issue status");
    const afterSameStatusInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox after same-status reorder");
    const sameStatusNotifications = afterSameStatusInbox.notifications.filter((notification) => notification.issueId === reorderFollowerIssue.id && !beforeSameStatusIds.has(notification.id));
    assert.equal(sameStatusNotifications.length, 0, "Same-status reorder created a follower notification");
    const afterSiblingActivity = await expectStatus(await call(`/api/issues/${reorderSiblingIssue.id}/activity`, { cookie: memberCookie }), 200, "sibling activity after same-status reorder");
    assert.deepEqual(afterSiblingActivity.activity.map((entry) => entry.id), beforeSiblingActivity.activity.map((entry) => entry.id), "Renumbered sibling received an activity entry");
    const ownActionIssue = await issueCreate(adminCookie, `${issueTitlePrefix} own notification exclusion`, { assigneeId: adminId });
    const adminInbox = await expectStatus(await call("/api/notifications", { cookie: adminCookie }), 200, "Admin notification inbox");
    assert.ok(!adminInbox.notifications.some((notification) => notification.issueId === ownActionIssue.id), "A user's own assignment or activity created a notification");
    const memberUnread = await expectStatus(await call("/api/notifications/unread-count", { cookie: memberCookie }), 200, "unread notification count");
    assert.deepEqual(Object.keys(memberUnread).sort(), ["unreadCount"], "Unread notification count returned unexpected fields");
    assert.ok(memberUnread.unreadCount > 0, "Unread notification count did not include the new notifications");
    const targetNotification = inboxAfterMention.notifications.find((notification) => notification.issueId === notificationIssue.id && notification.type === "assigned");
    await expectStatus(await call(`/api/notifications/${targetNotification.id}`, { method: "PATCH", cookie: memberCookie, body: { read: true } }), 200, "mark notification read");
    const markedReadInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox after mark read");
    assert.ok(markedReadInbox.notifications.find((notification) => notification.id === targetNotification.id)?.readAt, "Mark read did not persist");
    await expectStatus(await call(`/api/notifications/${targetNotification.id}`, { method: "PATCH", cookie: memberCookie, body: { read: false } }), 200, "mark notification unread");
    await expectStatus(await call("/api/notifications/read-all", { method: "POST", cookie: memberCookie, body: {} }), 200, "mark all notifications read");
    const readAllInbox = await expectStatus(await call("/api/notifications", { cookie: memberCookie }), 200, "inbox after mark all read");
    assert.equal(readAllInbox.unreadCount, 0, "Mark all read left unread notifications");

    const membersResponse = await expectStatus(await call("/api/members", { cookie: memberCookie }), 200, "member picker endpoint");
    assert.ok(membersResponse.members.some((record) => record.id === memberId && record.active), "Member picker did not return the active Member");
    await expectStatus(await call("/api/issues/not-a-uuid", { cookie: memberCookie }), 400, "malformed issue id");
    await expectStatus(await call("/api/issues", { method: "POST", cookie: memberCookie, body: { title: "Invalid\u0000 title" } }), 400, "control character validation");
    await expectStatus(await call("/api/issues", { method: "POST", cookie: memberCookie, body: { title: "Invalid\ntitle" } }), 400, "single-line title validation");
    await expectStatus(await call("/api/issues", { method: "POST", cookie: memberCookie, body: { title: "Invalid date", dueDate: "2026-02-30" } }), 400, "out-of-range date validation");
    await expectDateRangeError(await call("/api/issues", {
      method: "POST", cookie: memberCookie,
      body: { title: `${issueTitlePrefix} issue before date limit`, dueDate: "0000-01-01" },
    }), "issue date before lower limit");
    await expectDateRangeError(await call("/api/issues", {
      method: "POST", cookie: memberCookie,
      body: { title: `${issueTitlePrefix} issue after date limit`, dueDate: "2101-01-01" },
    }), "issue date after upper limit");
    await expectDateRangeError(await call("/api/cycles", {
      method: "POST", cookie: memberCookie,
      body: { name: `${issueTitlePrefix} cycle before date limit`, startDate: "0000-01-01" },
    }), "cycle date before lower limit");
    await expectDateRangeError(await call("/api/cycles", {
      method: "POST", cookie: memberCookie,
      body: { name: `${issueTitlePrefix} cycle after date limit`, startDate: "2101-01-01" },
    }), "cycle date after upper limit");
    await expectDateRangeError(await call("/api/projects", {
      method: "POST", cookie: memberCookie,
      body: { name: `${issueTitlePrefix} project before date limit`, startDate: "0000-01-01" },
    }), "project date before lower limit");
    await expectDateRangeError(await call("/api/projects", {
      method: "POST", cookie: memberCookie,
      body: { name: `${issueTitlePrefix} project after date limit`, targetDate: "2101-01-01" },
    }), "project date after upper limit");
    const multilineText = "First line\nSecond line\rThird line\twith a tab";
    await expectStatus(await call(`/api/cycles/${smokeCycle.id}`, {
      method: "PATCH",
      body: { goal: multilineText, version: smokeCycle.version },
    }), 401, "cycle goal update requires authentication");
    const updatedCycle = await expectStatus(await call(`/api/cycles/${smokeCycle.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { goal: multilineText, version: smokeCycle.version },
    }), 200, "multiline cycle goal update");
    assert.equal(updatedCycle.goal, multilineText, "Cycle goal did not preserve allowed multiline characters");
    await expectStatus(await call(`/api/cycles/${smokeCycle.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { goal: "Forbidden\u0000control", version: updatedCycle.version },
    }), 400, "NUL in multiline cycle goal rejected");
    await expectStatus(await call(`/api/cycles/${smokeCycle.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { goal: "Forbidden\u0001control", version: updatedCycle.version },
    }), 400, "other control in multiline cycle goal rejected");
    const multilineIssue = await issueCreate(memberCookie, `${issueTitlePrefix} multiline`, { description: multilineText });
    assert.equal(multilineIssue.description, multilineText, "Issue description did not preserve allowed multiline characters");
    await expectStatus(await call("/api/issues", { method: "POST", cookie: memberCookie, body: { title: `${issueTitlePrefix} NUL description`, description: "Forbidden\u0000control" } }), 400, "NUL in multiline description rejected");
    await expectStatus(await call("/api/issues", { method: "POST", cookie: memberCookie, body: { title: `${issueTitlePrefix} other control description`, description: "Forbidden\u0001control" } }), 400, "other control in multiline description rejected");
    const multilineComment = await expectStatus(await call(`/api/issues/${multilineIssue.id}/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: { body: multilineText },
    }), 201, "multiline comment");
    assert.equal(multilineComment.body, multilineText, "Comment body did not preserve allowed multiline characters");
    await expectStatus(await call(`/api/issues/${multilineIssue.id}/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: { body: "Forbidden\u0000control" },
    }), 400, "NUL in multiline comment rejected");
    await expectStatus(await call(`/api/issues/${multilineIssue.id}/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: { body: "Forbidden\u0001control" },
    }), 400, "other control in multiline comment rejected");
    const multilineProject = await expectStatus(await call("/api/projects", {
      method: "POST",
      cookie: memberCookie,
      body: { name: `${issueTitlePrefix} multiline project`, description: multilineText },
    }), 201, "multiline project description");
    createdProjectIds.add(multilineProject.id);
    assert.equal(multilineProject.description, multilineText, "Project description did not preserve allowed multiline characters");
    await expectStatus(await call("/api/projects", {
      method: "POST",
      cookie: memberCookie,
      body: { name: `${issueTitlePrefix} NUL project`, description: "Forbidden\u0000control" },
    }), 400, "NUL in multiline project description rejected");
    await expectStatus(await call("/api/projects", {
      method: "POST",
      cookie: memberCookie,
      body: { name: `${issueTitlePrefix} other control project`, description: "Forbidden\u0001control" },
    }), 400, "other control in multiline project description rejected");

    const defaultNamedCycleResponse = await call("/api/cycles", {
      method: "POST", cookie: memberCookie,
      body: { startDate: "1990-01-01" },
    });
    const defaultNamedCycle = await expectStatus(defaultNamedCycleResponse, 201, "cycle default name and duration");
    createdCycleIds.add(defaultNamedCycle.id);
    assert.match(defaultNamedCycle.name, /^Cycle \d+$/, "Cycle default name did not follow Cycle N");
    assert.equal(defaultNamedCycle.endDate, "1990-01-14", "Cycle default duration was not two weeks");
    const cycleA = await cycleCreate(memberCookie, `${issueTitlePrefix} cycle A`, "2095-01-01");
    assert.equal(cycleA.endDate, "2095-01-14", "Cycle default duration was not two weeks");
    const cycleB = await cycleCreate(memberCookie, `${issueTitlePrefix} cycle B`, "2095-01-16", "2095-01-30");
    await expectStatus(await call("/api/cycles", {
      method: "POST",
      cookie: memberCookie,
      body: { name: `${issueTitlePrefix} overlap`, startDate: "2095-01-14", endDate: "2095-01-20" },
    }), 409, "overlapping cycle dates rejected");
    await expectStatus(await call(`/api/cycles/${cycleB.id}`, {
      method: "PATCH", cookie: memberCookie,
      body: { version: cycleB.version, startDate: "2095-01-14" },
    }), 409, "cycle edit cannot overlap another cycle");
    const updatedCycleA = await expectStatus(await call(`/api/cycles/${cycleA.id}`, {
      method: "PATCH", cookie: memberCookie,
      body: { version: cycleA.version, goal: "Ship the next release", endDate: "2095-01-14" },
    }), 200, "versioned cycle edit");
    const staleCycleUpdate = await expectStatus(await call(`/api/cycles/${cycleA.id}`, {
      method: "PATCH", cookie: memberCookie,
      body: { version: cycleA.version, goal: "Stale cycle edit" },
    }), 409, "stale cycle version");
    assert.equal(staleCycleUpdate.current?.version, updatedCycleA.version, "Cycle conflict did not return the current record");
    const listedCycles = await expectStatus(await call("/api/cycles", { cookie: memberCookie }), 200, "cycle list");
    assert.ok(listedCycles.cycles.some((cycle) => cycle.id === cycleA.id && cycle.goal === "Ship the next release"), "Cycle list omitted the created cycle");
    const activeCycleExists = listedCycles.cycles.some((cycle) => cycle.status === "Active");

    const doneCycleIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle done`, { status: "Done", assigneeId: memberId, estimate: 3 });
    const blockedCycleIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle blocked`, { status: "In Progress", assigneeId: memberId });
    const projectCycleIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle project`, { status: "Todo", projectId: multilineProject.id, estimate: 5 });
    const movedCycleIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle moved`, { status: "Todo", estimate: 2 });
    const bulkMovedCycleIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle bulk moved`, { status: "Todo", estimate: 4 });
    const blockerIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle blocker`, { status: "In Progress" });
    await expectStatus(await call(`/api/issues/${blockerIssue.id}/relations`, {
      method: "POST", cookie: memberCookie,
      body: { blockerIssueId: blockerIssue.id, blockedIssueId: blockedCycleIssue.id },
    }), 201, "cycle issue blocker relation");
    await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
      method: "POST", cookie: memberCookie,
      body: { issues: [{ id: doneCycleIssue.id, version: doneCycleIssue.version }] },
    }), 200, "single issue added to cycle");
    const [blockedIssueCurrent, projectIssueCurrent, movedIssueCurrent, bulkMovedIssueCurrent] = await Promise.all([
      blockedCycleIssue.id, projectCycleIssue.id, movedCycleIssue.id, bulkMovedCycleIssue.id,
    ].map(async (id) => expectStatus(await call(`/api/issues/${id}`, { cookie: memberCookie }), 200, "cycle issue before bulk add")));
    await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
      method: "POST", cookie: memberCookie,
      body: { issues: [blockedIssueCurrent, projectIssueCurrent, movedIssueCurrent, bulkMovedIssueCurrent].map(({ id, version }) => ({ id, version })) },
    }), 200, "bulk issues from backlog and project added to cycle");
    const startResponse = await call(`/api/cycles/${cycleA.id}/start`, {
      method: "POST", cookie: memberCookie, body: { version: updatedCycleA.version },
    });
    let startedCycle;
    if (activeCycleExists) {
      const activeConflict = await expectStatus(startResponse, 409, "only one active cycle allowed");
      assert.equal(activeConflict.current?.status, "Active", "Active-cycle conflict did not include the active cycle");
    } else {
      startedCycle = await expectStatus(startResponse, 200, "cycle start");
      assert.equal(startedCycle.status, "Active", "Starting the cycle did not set Active status");
      await expectStatus(await call(`/api/cycles/${cycleB.id}/start`, {
        method: "POST", cookie: memberCookie, body: { version: cycleB.version },
      }), 409, "only one active cycle allowed");
    }
    const extraCycleIssue = await issueCreate(memberCookie, `${issueTitlePrefix} cycle scope change`);
    const addedExtra = await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
      method: "POST", cookie: memberCookie,
      body: { issues: [{ id: extraCycleIssue.id, version: extraCycleIssue.version }] },
    }), 200, "post-start cycle addition");
    const extraIssueAfterAdd = addedExtra.issues.find(({ issue }) => issue.id === extraCycleIssue.id)?.issue;
    assert.ok(extraIssueAfterAdd, "Added cycle issue was not returned");
    await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
      method: "DELETE", cookie: memberCookie,
      body: { issues: [{ id: extraCycleIssue.id, version: extraIssueAfterAdd.version }] },
    }), 200, "single issue removed from cycle");
    const bulkScopeIssues = await Promise.all([
      issueCreate(memberCookie, `${issueTitlePrefix} bulk scope one`),
      issueCreate(memberCookie, `${issueTitlePrefix} bulk scope two`),
    ]);
    const bulkScopeAdded = await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
      method: "POST", cookie: memberCookie,
      body: { issues: bulkScopeIssues.map(({ id, version }) => ({ id, version })) },
    }), 200, "bulk post-start cycle additions");
    await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
      method: "DELETE", cookie: memberCookie,
      body: { issues: bulkScopeAdded.issues.map(({ issue }) => ({ id: issue.id, version: issue.version })) },
    }), 200, "bulk cycle issue removals");
    const cycleStats = await expectStatus(await call(`/api/cycles/${cycleA.id}`, { cookie: memberCookie }), 200, "cycle stats and scope log");
    assert.deepEqual(cycleStats.stats.scope, { issueCount: 5, estimatePoints: 14 }, "Cycle scope totals were incorrect");
    assert.deepEqual(cycleStats.stats.completed, { issueCount: 1, estimatePoints: 3 }, "Cycle completed totals were incorrect");
    assert.deepEqual(cycleStats.stats.remaining, { issueCount: 4, estimatePoints: 11 }, "Cycle remaining totals were incorrect");
    assert.deepEqual(cycleStats.stats.blocked, { issueCount: 1, estimatePoints: 0 }, "Cycle blocked totals were incorrect");
    assert.equal(cycleStats.stats.unestimatedIssueCount, 1, "Unestimated issues were not counted separately");
    assert.ok(cycleStats.stats.assignees.some((row) => row.assigneeId === memberId && row.scope.issueCount === 2), "Per-assignee cycle breakdown was missing");
    const scopeActions = cycleStats.scopeChanges.map(({ action }) => action);
    if (startedCycle) {
      assert.equal(scopeActions.filter((action) => action === "added").length, 3, "Post-start additions were not logged");
      assert.equal(scopeActions.filter((action) => action === "removed").length, 3, "Post-start removals were not logged");
      const scopedIssueIds = new Set([extraCycleIssue.id, ...bulkScopeIssues.map(({ id }) => id)]);
      assert.ok(cycleStats.scopeChanges.every(({ actorId, issue, createdAt }) => actorId === memberId && scopedIssueIds.has(issue?.id) && createdAt), "Scope log did not include actor, time, and issue");
    } else {
      assert.deepEqual(scopeActions, [], "Upcoming cycle scope changes were logged before the cycle started");
    }
    const projectCycleBeforeStaleMove = await expectStatus(await call(`/api/issues/${projectCycleIssue.id}`, { cookie: memberCookie }), 200, "project issue before stale bulk move");
    const bulkMovedBeforeStaleMove = await expectStatus(await call(`/api/issues/${bulkMovedCycleIssue.id}`, { cookie: memberCookie }), 200, "bulk-moved issue before stale move");
    await expectStatus(await call(`/api/cycles/${cycleA.id}/move`, {
      method: "POST", cookie: memberCookie,
      body: { targetCycleId: cycleB.id, issues: [
        { id: movedCycleIssue.id, version: movedCycleIssue.version + 1 },
        { id: projectCycleIssue.id, version: projectCycleBeforeStaleMove.version - 1 },
        { id: bulkMovedCycleIssue.id, version: bulkMovedBeforeStaleMove.version },
      ] },
    }), 409, "bulk cycle move rejects stale issue versions");
    const unchangedAfterStaleMove = await expectStatus(await call(`/api/issues/${movedCycleIssue.id}`, { cookie: memberCookie }), 200, "issue after rejected bulk move");
    assert.equal(unchangedAfterStaleMove.cycleId, cycleA.id, "Rejected bulk cycle move partially moved an issue");
    const movedSingle = await expectStatus(await call(`/api/cycles/${cycleA.id}/move`, {
      method: "POST", cookie: memberCookie,
      body: { targetCycleId: cycleB.id, issues: [{ id: movedCycleIssue.id, version: movedCycleIssue.version + 1 }] },
    }), 200, "single cycle-to-cycle move");
    assert.equal(movedSingle.issues[0]?.issue.cycleId, cycleB.id, "Moved issue did not join the target cycle");
    const projectCycleCurrent = await expectStatus(await call(`/api/issues/${projectCycleIssue.id}`, { cookie: memberCookie }), 200, "issue before bulk cycle move");
    const bulkMovedCurrent = await expectStatus(await call(`/api/issues/${bulkMovedCycleIssue.id}`, { cookie: memberCookie }), 200, "second issue before bulk cycle move");
    const movedBulk = await expectStatus(await call(`/api/cycles/${cycleA.id}/move`, {
      method: "POST", cookie: memberCookie,
      body: { targetCycleId: cycleB.id, issues: [
        { id: projectCycleIssue.id, version: projectCycleCurrent.version },
        { id: bulkMovedCycleIssue.id, version: bulkMovedCurrent.version },
      ] },
    }), 200, "bulk cycle-to-cycle move");
    assert.equal(movedBulk.issues.length, 2, "Bulk cycle move omitted an issue");
    assert.ok(movedBulk.issues.every(({ issue }) => issue.cycleId === cycleB.id), "Bulk moved issues did not join the target cycle");
    if (startedCycle) {
      await expectStatus(await call(`/api/cycles/${cycleA.id}/close`, {
        method: "POST", cookie: memberCookie,
        body: { version: startedCycle.version, unfinishedAction: "carry" },
      }), 200, "active cycle close and carry-over");
      const closedCycle = await expectStatus(await call(`/api/cycles/${cycleA.id}`, { cookie: memberCookie }), 200, "completed cycle snapshot");
      assert.equal(closedCycle.cycle.status, "Completed", "Closing the cycle did not set Completed status");
      assert.deepEqual(closedCycle.snapshot.completed.map(({ id }) => id), [doneCycleIssue.id], "Completed cycle snapshot omitted its completed issue");
      assert.deepEqual(closedCycle.snapshot.unfinished.map(({ id }) => id), [blockedCycleIssue.id], "Completed cycle snapshot omitted its unfinished issue");
      assert.deepEqual(closedCycle.snapshot.carriedOver.map(({ id }) => id), [blockedCycleIssue.id], "Unfinished issue was not recorded as carried over");
      await expectStatus(await call(`/api/cycles/${cycleA.id}`, {
        method: "PATCH", cookie: memberCookie,
        body: { version: closedCycle.cycle.version, goal: "Cannot edit completed cycle" },
      }), 409, "completed cycle is read-only");
      await expectStatus(await call(`/api/cycles/${cycleA.id}/issues`, {
        method: "POST", cookie: memberCookie,
        body: { issues: [{ id: extraCycleIssue.id, version: 3 }] },
      }), 409, "completed cycle rejects issue additions");
      const targetAfterCarry = await expectStatus(await call(`/api/cycles/${cycleB.id}`, { cookie: memberCookie }), 200, "cycle after carry-over");
      assert.ok(targetAfterCarry.issues.some(({ id }) => id === blockedCycleIssue.id), "Unfinished issue was lost during carry-over");
      const startedNext = await expectStatus(await call(`/api/cycles/${cycleB.id}/start`, {
        method: "POST", cookie: memberCookie, body: { version: cycleB.version },
      }), 200, "start next cycle");
      const closedNext = await expectStatus(await call(`/api/cycles/${cycleB.id}/close`, {
        method: "POST", cookie: memberCookie,
        body: { version: startedNext.version, unfinishedAction: "carry" },
      }), 200, "carry-over creates the next cycle when missing");
      assert.ok(closedNext.carriedOverCycle?.id && closedNext.carriedOverCycle.status === "Upcoming", "Closing without a next cycle did not create one");
      createdCycleIds.add(closedNext.carriedOverCycle.id);
      const autoNextCycle = await expectStatus(await call(`/api/cycles/${closedNext.carriedOverCycle.id}`, { cookie: memberCookie }), 200, "created follow-on cycle");
      assert.ok(autoNextCycle.issues.some(({ id }) => id === blockedCycleIssue.id), "Auto-created next cycle did not receive unfinished issues");
      const startedAutoNext = await expectStatus(await call(`/api/cycles/${closedNext.carriedOverCycle.id}/start`, {
        method: "POST", cookie: memberCookie, body: { version: autoNextCycle.cycle.version },
      }), 200, "start auto-created cycle");
      await expectStatus(await call(`/api/cycles/${closedNext.carriedOverCycle.id}/close`, {
        method: "POST", cookie: memberCookie,
        body: { version: startedAutoNext.version, unfinishedAction: "backlog" },
      }), 200, "cycle close returns unfinished work to backlog");
      const backloggedIssue = await expectStatus(await call(`/api/issues/${blockedCycleIssue.id}`, { cookie: memberCookie }), 200, "issue after backlog return");
      assert.equal(backloggedIssue.cycleId, null, "Backlog close choice did not clear the issue cycle");
    } else {
      const existingCompletedCycle = listedCycles.cycles.find((cycle) => cycle.status === "Completed");
      if (existingCompletedCycle) {
        await expectStatus(await call(`/api/cycles/${existingCompletedCycle.id}`, {
          method: "PATCH", cookie: memberCookie,
          body: { version: existingCompletedCycle.version, goal: "Cannot edit completed cycle" },
        }), 409, "completed cycle is read-only");
        await expectStatus(await call(`/api/cycles/${existingCompletedCycle.id}/issues`, {
          method: "POST", cookie: memberCookie,
          body: { issues: [{ id: extraCycleIssue.id, version: 3 }] },
        }), 409, "completed cycle rejects issue additions");
        await expectStatus(await call(`/api/issues/${extraCycleIssue.id}`, {
          method: "PATCH", cookie: memberCookie,
          body: { version: 3, cycleId: existingCompletedCycle.id },
        }), 400, "issue API cannot assign to a completed cycle");
      }
      console.log("Cycle close, snapshots, and carry-over smoke skipped: the existing workspace already has an Active cycle.");
    }

    const createdIssues = await Promise.all(Array.from({ length: 20 }, (_, index) => issueCreate(memberCookie, `${issueTitlePrefix} parallel ${index + 1}`, { assigneeId: memberId })));
    assert.equal(new Set(createdIssues.map((issue) => issue.identifier)).size, 20, "Concurrent issue identifiers were not unique");
    const reorderResponse = await expectStatus(await call(`/api/issues/${createdIssues[1].id}/position`, {
      method: "PATCH",
      cookie: memberCookie,
      body: { version: createdIssues[1].version, status: "Backlog", placement: "before", relativeIssueId: createdIssues[2].id },
    }), 200, "server-computed issue reorder");
    const relativeIssue = await expectStatus(await call(`/api/issues/${createdIssues[2].id}`, { cookie: memberCookie }), 200, "relative issue after reorder");
    assert.ok(reorderResponse.position < relativeIssue.position, "Server-side reorder did not place the issue before its target");
    const initial = await expectStatus(await call(`/api/issues/${createdIssues[0].id}`, { cookie: memberCookie }), 200, "issue before version test");
    await expectStatus(await call(`/api/issues/${initial.id}`, { method: "PATCH", cookie: memberCookie, body: { version: initial.version, title: `${initial.title} updated` } }), 200, "first versioned issue update");
    const conflict = await expectStatus(await call(`/api/issues/${initial.id}`, { method: "PATCH", cookie: memberCookie, body: { version: initial.version, title: "Stale update" } }), 409, "stale issue version");
    assert.ok(conflict.current?.id === initial.id && conflict.current.version !== initial.version, "Version conflict did not return the current issue record");

    const first = await issueCreate(memberCookie, `${issueTitlePrefix} circular A`);
    const second = await issueCreate(memberCookie, `${issueTitlePrefix} circular B`);
    await expectStatus(await call(`/api/issues/${first.id}/relations`, { method: "POST", cookie: memberCookie, body: { blockerIssueId: first.id, blockedIssueId: second.id } }), 201, "first blocking relation");
    await expectStatus(await call(`/api/issues/${second.id}/relations`, { method: "POST", cookie: memberCookie, body: { blockerIssueId: second.id, blockedIssueId: first.id } }), 409, "circular blocking relation rejected");

    await expectStatus(await call("/api/settings/members", { method: "DELETE", cookie: adminCookie, body: {} }), 405, "member-removal route method safety");
    await expectStatus(await call(`/api/settings/members/${memberMembershipId}`, { method: "DELETE", cookie: adminCookie, body: {} }), 200, "Admin removes temporary Member");
    memberRemoved = true;
    await expectStatus(await call("/api/issues", { cookie: memberCookie }), 401, "removed Member cannot read issues");
    await expectStatus(await call(attachmentUrl, { cookie: memberCookie }), 401, "removed Member cannot download attachment");
    await expectStatus(await call("/api/issues", { method: "POST", cookie: memberCookie, body: { title: "Removed member write" } }), 401, "removed Member cannot create issues");
    await expectStatus(await call(`/api/issues/${createdIssues[1].id}`, { method: "PATCH", cookie: memberCookie, body: { version: 3, title: "Removed member update" } }), 401, "removed Member cannot update issues");
    if (!databaseConnected) {
      await db.connect();
      databaseConnected = true;
    }
    const unassigned = await db.query("SELECT assignee_id FROM issues WHERE id = $1 AND workspace_id = $2", [createdIssues[1].id, workspaceId]);
    assert.equal(unassigned.rows[0]?.assignee_id, null, "Removing Member did not unassign their open issue");
    const unassignmentActivity = await db.query("SELECT id FROM activity WHERE workspace_id = $1 AND issue_id = $2 AND actor_id = $3 AND action = 'unassigned'", [workspaceId, createdIssues[1].id, adminId]);
    assert.ok(unassignmentActivity.rowCount, "Removing Member did not record the unassignment activity");
    console.log("API smoke passed: access checks, attachment validation/access/archive behavior, notification and inbox flows, cycle planning and stats, version conflicts, 20 atomic issue identifiers, and circular relation rejection.");
  }
} finally {
  await cleanup();
  if (cleanupError) throw cleanupError;
  if (bootstrapCreated) console.log("The temporary workspace and test data were cleaned up.");
  else if (createdUserIds.size) console.log("Only smoke-created invitations, members, cycles, issues, and projects were cleaned up; the pre-existing workspace and Admin were preserved.");
}
