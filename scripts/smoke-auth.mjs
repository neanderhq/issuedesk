import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const origin = process.argv[2] || "http://127.0.0.1:3000";
const originUrl = new URL(origin);
if (!new Set(["127.0.0.1", "localhost"]).has(originUrl.hostname)) throw new Error("Auth smoke only runs against a loopback preview origin");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; run with node --env-file=.env.local");
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!new Set(["127.0.0.1", "localhost"]).has(databaseUrl.hostname) || databaseUrl.port !== "55432") {
  throw new Error("Auth smoke only runs against the local embedded PostgreSQL database on port 55432");
}

const runId = randomUUID();
const adminEmail = `phase1-smoke-admin-${runId}@example.invalid`;
const memberEmail = `phase1-smoke-member-${runId}@example.invalid`;
const secondMemberEmail = `phase1-smoke-restore-check-${runId}@example.invalid`;
const adminPassword = `Admin-${randomUUID()}-${randomUUID()}`;
const memberPassword = `Member-${randomUUID()}-${randomUUID()}`;
const secondMemberPassword = `Member-${randomUUID()}-${randomUUID()}`;
const changedAdminPassword = `Changed-${randomUUID()}-${randomUUID()}`;
const changedMemberPassword = `Reset-${randomUUID()}-${randomUUID()}`;
const ipAddress = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
const createdUserIds = new Set();
const createdInvitationIds = new Set();
let dbConnected = false;
let createdPasswordRequest = false;
let createdWorkspaceId;
let bootstrapCreated = false;
let cleanupError;
const db = new Client({ connectionString: process.env.DATABASE_URL });

function cookieFrom(response) {
  const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
  return cookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function call(path, { method = "GET", body, cookie, requestOrigin = origin } = {}) {
  const headers = { "x-forwarded-for": ipAddress };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers.origin = requestOrigin;
    headers["content-type"] = "application/json";
  }
  return fetch(new URL(path, origin), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function expectStatus(response, expected, label) {
  const payload = await readJson(response);
  assert.equal(response.status, expected, `${label}: expected ${expected}, received ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function expectLoginRedirect(path) {
  const response = await call(path);
  assert.ok([307, 308].includes(response.status), `${path}: expected a login redirect, received ${response.status}`);
  const location = new URL(response.headers.get("location"), origin);
  assert.equal(location.pathname, "/login", `${path}: signed-out redirect must target /login`);
  assert.equal(location.search, "", `${path}: signed-out redirect must not include a query string`);
}

async function cleanup() {
  if (!dbConnected) {
    await db.connect();
    dbConnected = true;
  }
  try {
    if (createdUserIds.size) await db.query("DELETE FROM \"user\" WHERE id = ANY($1::text[])", [[...createdUserIds]]);
    if (createdInvitationIds.size) await db.query("DELETE FROM invitations WHERE id = ANY($1::uuid[])", [[...createdInvitationIds]]);
    if (createdPasswordRequest) await db.query("DELETE FROM password_reset_requests WHERE email = $1", [memberEmail]);
    if (bootstrapCreated && createdWorkspaceId) {
      await db.query("DELETE FROM workspaces WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = $1)", [createdWorkspaceId]);
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    await db.end();
    dbConnected = false;
  }
}

try {
  assert.ok(originUrl.port === "3000", "Auth smoke preview must use port 3000");
  const anonymousMe = await call("/api/me");
  await expectStatus(anonymousMe, 401, "signed-out /api/me");
  await expectStatus(await call("/api/settings/members"), 401, "signed-out member settings");
  await expectStatus(await call("/api/settings/workspace"), 401, "signed-out workspace settings");
  for (const path of ["/inbox", "/my-issues", "/backlog", "/board", "/list", "/projects", "/cycles", "/archive", "/settings/members", "/settings/workspace"]) {
    await expectLoginRedirect(path);
  }
  await expectStatus(await call("/api/password-reset-requests", { method: "POST", body: { email: `foreign-${runId}@example.invalid` }, requestOrigin: "https://attacker.invalid" }), 403, "foreign-Origin POST");

  const registrationStatus = await readJson(await call("/api/registration-status"));
  let adminCookie = "";
  let adminUserId = "";
  if (registrationStatus.bootstrapAllowed) {
    bootstrapCreated = true;
    const created = await call("/api/signup", { method: "POST", body: { name: "Smoke Admin", email: adminEmail, password: adminPassword } });
    const account = await expectStatus(created, 200, "first-account bootstrap");
    adminCookie = cookieFrom(created);
    adminUserId = account.user.id;
    createdUserIds.add(adminUserId);
    assert.ok(adminCookie, "first account did not receive a session cookie");
    console.log("First-user bootstrap created a temporary Admin workspace.");
  } else {
    if (!process.env.SMOKE_AUTH_ADMIN_EMAIL || !process.env.SMOKE_AUTH_ADMIN_PASSWORD) {
      const rejected = await call("/api/signup", { method: "POST", body: { name: "No Invite", email: `no-invite-${runId}@example.invalid`, password: adminPassword } });
      await expectStatus(rejected, 403, "signup without an invitation");
      console.log("Existing workspace detected. Signed-out and Origin checks passed; admin-flow checks require SMOKE_AUTH_ADMIN_EMAIL and SMOKE_AUTH_ADMIN_PASSWORD and were skipped to preserve existing data.");
      process.exitCode = 2;
    } else {
      const login = await call("/api/auth/sign-in/email", { method: "POST", body: { email: process.env.SMOKE_AUTH_ADMIN_EMAIL, password: process.env.SMOKE_AUTH_ADMIN_PASSWORD } });
      await expectStatus(login, 200, "existing Admin sign-in");
      adminCookie = cookieFrom(login);
      assert.ok(adminCookie, "Admin sign-in did not return a session cookie");
    }
  }

  if (adminCookie) {
    const adminMeResponse = await call("/api/me", { cookie: adminCookie });
    const adminMe = await expectStatus(adminMeResponse, 200, "Admin session");
    assert.equal(adminMe.role, "Admin");
    createdWorkspaceId = adminMe.workspace.id;
    const secondSignup = await call("/api/signup", { method: "POST", body: { name: "No Invite", email: `no-invite-${runId}@example.invalid`, password: memberPassword } });
    await expectStatus(secondSignup, 403, "signup without an invitation after bootstrap");

    const currentMembers = await readJson(await call("/api/settings/members", { cookie: adminCookie }));
    const adminMembership = currentMembers.members.find((member) => member.userId === adminUserId || member.email === (process.env.SMOKE_AUTH_ADMIN_EMAIL || adminEmail));
    assert.ok(adminMembership, "Admin membership was not returned by member settings");
    const workspaceResponse = await call("/api/settings/workspace", { cookie: adminCookie });
    const workspaceData = await expectStatus(workspaceResponse, 200, "workspace settings read");
    await expectStatus(await call("/api/settings/workspace", { method: "PUT", cookie: adminCookie, body: workspaceData.workspace }), 200, "Admin workspace settings update");
    await expectStatus(await call("/api/settings/workspace", {
      method: "PUT",
      cookie: adminCookie,
      body: { ...workspaceData.workspace, name: "A\u0000B" },
    }), 400, "workspace name rejects NUL control character");

    for (const [path, label] of [
      ["/inbox", "Inbox"], ["/my-issues", "My Issues"], ["/backlog", "Backlog"], ["/board", "Board"], ["/list", "List"],
      ["/projects", "Projects"], ["/cycles", "Cycles"], ["/archive", "Archive"], ["/settings/members", "Members"], ["/settings/workspace", "Workspace"],
    ]) {
      const pageResponse = await call(path, { cookie: adminCookie });
      assert.equal(pageResponse.status, 200, `${path}: authenticated page should render`);
      const pageHtml = await pageResponse.text();
      const activeNavItem = pageHtml.match(/<button\b(?=[^>]*aria-current="page")[^>]*>([\s\S]*?)<\/button>/)?.[1] || "";
      assert.ok(activeNavItem.includes(label), `${path}: ${label} should be the active accessible navigation item`);
    }

    const inviteResponse = await call("/api/settings/invitations", { method: "POST", cookie: adminCookie, body: { email: memberEmail, role: "Member" } });
    const invite = await expectStatus(inviteResponse, 201, "Admin invitation creation");
    createdInvitationIds.add(invite.invitation.id);
    const inviteUrl = new URL(invite.inviteUrl);
    const invitationToken = inviteUrl.searchParams.get("token");
    assert.ok(inviteUrl.pathname === "/invite" && invitationToken, "Invitation link is not a copyable /invite link");
    const revokeInvite = await call("/api/settings/invitations", { method: "POST", cookie: adminCookie, body: { email: `revoke-${runId}@example.invalid`, role: "Member" } });
    const revokeInviteResult = await expectStatus(revokeInvite, 201, "second Admin invitation");
    createdInvitationIds.add(revokeInviteResult.invitation.id);

    const memberSignup = await call("/api/signup", { method: "POST", body: { name: "Smoke Member", email: memberEmail, password: memberPassword, invitationToken } });
    const memberResult = await expectStatus(memberSignup, 200, "invited Member signup");
    const memberCookie = cookieFrom(memberSignup);
    assert.ok(memberCookie, "invited Member did not receive a session cookie");
    createdUserIds.add(memberResult.user.id);
    const memberMe = await expectStatus(await call("/api/me", { cookie: memberCookie }), 200, "invited Member session");
    assert.equal(memberMe.role, "Member");
    const membersAfterSignup = await readJson(await call("/api/settings/members", { cookie: adminCookie }));
    const member = membersAfterSignup.members.find((item) => item.userId === memberResult.user.id);
    assert.ok(member, "Member membership missing after invitation acceptance");

    const restoreCheckInviteResponse = await call("/api/settings/invitations", { method: "POST", cookie: adminCookie, body: { email: secondMemberEmail, role: "Member" } });
    const restoreCheckInvite = await expectStatus(restoreCheckInviteResponse, 201, "second Member invitation for restore authorization check");
    createdInvitationIds.add(restoreCheckInvite.invitation.id);
    const restoreCheckToken = new URL(restoreCheckInvite.inviteUrl).searchParams.get("token");
    assert.ok(restoreCheckToken, "Restore authorization invitation did not include a token");
    const restoreCheckSignup = await call("/api/signup", { method: "POST", body: { name: "Smoke Restore Check", email: secondMemberEmail, password: secondMemberPassword, invitationToken: restoreCheckToken } });
    const restoreCheckMember = await expectStatus(restoreCheckSignup, 200, "second invited Member signup for restore authorization check");
    const restoreCheckCookie = cookieFrom(restoreCheckSignup);
    assert.ok(restoreCheckCookie, "Restore authorization Member signup did not return a session cookie");
    createdUserIds.add(restoreCheckMember.user.id);
    assert.equal((await expectStatus(await call("/api/me", { cookie: restoreCheckCookie }), 200, "restore authorization Member session")).role, "Member");

    await expectStatus(await call(`/api/settings/members/${member.id}`, { method: "PATCH", cookie: adminCookie, body: { role: "Admin" } }), 200, "Admin promotes Member");
    await expectStatus(await call(`/api/settings/members/${member.id}`, { method: "PATCH", cookie: adminCookie, body: { role: "Member" } }), 200, "Admin restores Member role");
    await expectStatus(await call(`/api/settings/invitations/${revokeInviteResult.invitation.id}`, { method: "DELETE", cookie: adminCookie, body: {} }), 200, "Admin revokes pending invitation");

    const reusedInvite = await call("/api/signup", { method: "POST", body: { name: "Duplicate", email: `duplicate-${runId}@example.invalid`, password: memberPassword, invitationToken } });
    await expectStatus(reusedInvite, 400, "single-use invitation token");

    const adminRoutes = [
      ["GET", "/api/settings/members"],
      ["POST", "/api/settings/invitations", { email: `member-denied-${runId}@example.invalid`, role: "Member" }],
      ["DELETE", `/api/settings/invitations/${invite.invitation.id}`, {}],
      ["PATCH", `/api/settings/members/${member.id}`, { role: "Admin" }],
      ["DELETE", `/api/settings/members/${member.id}`, {}],
      ["POST", `/api/settings/members/${member.id}/password-reset`, {}],
      ["PUT", "/api/settings/workspace", { name: "Not Allowed", issueKeyPrefix: "NO" }],
    ];
    for (const [method, path, body] of adminRoutes) {
      await expectStatus(await call(path, { method, body, cookie: memberCookie }), 403, `Member ${method} ${path}`);
    }

    if (bootstrapCreated) {
      const lastAdminRole = await call(`/api/settings/members/${adminMembership.id}`, { method: "PATCH", cookie: adminCookie, body: { role: "Member" } });
      await expectStatus(lastAdminRole, 409, "last Admin demotion protection");
      const lastAdminRemoval = await call(`/api/settings/members/${adminMembership.id}`, { method: "DELETE", cookie: adminCookie, body: {} });
      await expectStatus(lastAdminRemoval, 409, "last Admin removal protection");
    } else {
      console.log("Skipped last-Admin mutation checks to avoid changing an existing member's role or access.");
    }

    const resetRequest = await call("/api/password-reset-requests", { method: "POST", body: { email: memberEmail } });
    await expectStatus(resetRequest, 200, "forgot-password request");
    createdPasswordRequest = true;
    const requestList = await readJson(await call("/api/settings/members", { cookie: adminCookie }));
    assert.ok(requestList.resetRequests.some((item) => item.email === memberEmail), "Admin did not see the pending password reset request");

    const resetLinkResponse = await call(`/api/settings/members/${member.id}/password-reset`, { method: "POST", cookie: adminCookie, body: {} });
    const resetLinkResult = await expectStatus(resetLinkResponse, 200, "Admin-generated password reset link");
    const resetUrl = new URL(resetLinkResult.resetLink);
    assert.equal(resetUrl.origin, originUrl.origin, "Reset link must use the current local preview origin");
    assert.equal(resetUrl.pathname, "/reset-password", "Reset link must use the app reset page");
    assert.equal(resetUrl.searchParams.getAll("token").length, 1, "Reset link must include exactly one token query parameter");
    assert.doesNotMatch(resetUrl.pathname, /^\/api\/auth\/reset-password\//, "Reset link must not use Better Auth's broken path");
    const resetToken = resetUrl.searchParams.get("token");
    assert.ok(resetToken.length >= 20, "Generated password reset URL did not include a token");
    assert.equal(resetLinkResult.resetLink, `${origin}/reset-password?token=${encodeURIComponent(resetToken)}`, "Reset link must encode the submitted token on the expected origin");
    assert.equal(resetLinkResult.expiresInSeconds, 3600);

    const preResetLogin = await call("/api/auth/sign-in/email", { method: "POST", body: { email: memberEmail, password: memberPassword } });
    await expectStatus(preResetLogin, 200, "Member login before password reset");
    const preResetMemberCookie = cookieFrom(preResetLogin);
    assert.ok(preResetMemberCookie, "Pre-reset Member login did not return a session cookie");
    await expectStatus(await call("/api/me", { cookie: preResetMemberCookie }), 200, "Member session before password reset");

    const resetResponse = await call("/api/password-reset", { method: "POST", body: { token: resetToken, newPassword: changedMemberPassword } });
    await expectStatus(resetResponse, 200, "one-time password reset");
    await expectStatus(await call("/api/me", { cookie: preResetMemberCookie }), 401, "password reset revokes every pre-reset Member session");
    await expectStatus(await call("/api/password-reset", { method: "POST", body: { token: resetToken, newPassword: memberPassword } }), 400, "one-time reset token reuse");

    const memberLogin = await call("/api/auth/sign-in/email", { method: "POST", body: { email: memberEmail, password: changedMemberPassword } });
    await expectStatus(memberLogin, 200, "Member login after password reset");
    const activeMemberCookie = cookieFrom(memberLogin);
    assert.ok(activeMemberCookie, "Member login did not return a session cookie");
    const removedResponse = await call(`/api/settings/members/${member.id}`, { method: "DELETE", cookie: adminCookie, body: {} });
    await expectStatus(removedResponse, 200, "Admin removes Member for removed-access sign-in check");
    const revokedSession = await call("/api/me", { cookie: activeMemberCookie });
    assert.ok([401, 403].includes(revokedSession.status), `removed Member session remained active: ${revokedSession.status}`);
    const removedSignin = await call("/api/auth/sign-in/email", { method: "POST", body: { email: memberEmail, password: changedMemberPassword } });
    const removedSigninPayload = await expectStatus(removedSignin, 403, "removed Member sign-in");
    assert.equal(removedSigninPayload.message, "Your access to this workspace was removed. Ask an Admin to invite you again.");
    assert.equal(cookieFrom(removedSignin), "", "Removed Member sign-in must not issue a session cookie");
    await expectStatus(await call("/api/me"), 401, "session validation after rejected removed Member sign-in");
    assert.equal((await call("/api/me", { cookie: memberCookie })).status, 401, "Removed Member's original session must be revoked");
    await expectStatus(await call(`/api/settings/members/${member.id}`, { method: "PATCH", cookie: restoreCheckCookie, body: { active: true } }), 403, "active Member cannot restore a removed Member");
    await expectStatus(await call(`/api/settings/members/${member.id}`, { method: "PATCH", cookie: adminCookie, body: { active: true } }), 200, "Admin restores removed Member");
    const restoredSignin = await call("/api/auth/sign-in/email", { method: "POST", body: { email: memberEmail, password: changedMemberPassword } });
    await expectStatus(restoredSignin, 200, "restored Member sign-in with existing password");
    const restoredMemberCookie = cookieFrom(restoredSignin);
    assert.ok(restoredMemberCookie, "Restored Member sign-in did not return a session cookie");
    const restoredMember = await expectStatus(await call("/api/me", { cookie: restoredMemberCookie }), 200, "restored Member session");
    assert.equal(restoredMember.role, "Member", "Restoring membership must preserve its existing role");

    const adminSecondLogin = await call("/api/auth/sign-in/email", { method: "POST", body: { email: process.env.SMOKE_AUTH_ADMIN_EMAIL || adminEmail, password: bootstrapCreated ? adminPassword : process.env.SMOKE_AUTH_ADMIN_PASSWORD } });
    await expectStatus(adminSecondLogin, 200, "Admin second session login");
    const adminSecondCookie = cookieFrom(adminSecondLogin);

    if (bootstrapCreated) {
      const adminChanged = await call("/api/account/password", { method: "POST", cookie: adminCookie, body: { currentPassword: adminPassword, newPassword: changedAdminPassword } });
      await expectStatus(adminChanged, 200, "signed-in password change");
      const previousAdminCookie = adminCookie;
      adminCookie = cookieFrom(adminChanged);
      assert.ok(adminCookie, "Password change did not return a replacement Admin session cookie");
      await expectStatus(await call("/api/me", { cookie: previousAdminCookie }), 401, "old Admin session immediately after password change");
      await expectStatus(await call("/api/me", { cookie: adminCookie }), 200, "replacement Admin session after password change");
      const otherAdminSession = await call("/api/me", { cookie: adminSecondCookie });
      assert.ok([401, 403].includes(otherAdminSession.status), `other Admin session survived password change: ${otherAdminSession.status}`);
    }
    const logout = await call("/api/auth/sign-out", { method: "POST", cookie: adminCookie, body: {} });
    await expectStatus(logout, 200, "logout");
    await expectStatus(await call("/api/me", { cookie: adminCookie }), 401, "session after logout");
    console.log("Auth smoke passed: bootstrap/invitation, role enforcement, last-Admin guard, reset/change password, session removal/logout, Origin rejection.");
  }
} finally {
  await cleanup();
  if (cleanupError) throw cleanupError;
  if (bootstrapCreated) console.log("Temporary smoke users and the newly-created empty workspace were cleaned up; pre-existing workspace/user records were never deleted.");
  else if (createdUserIds.size) console.log("Only the unique smoke-created Member was cleaned up; the existing workspace and Admin were preserved.");
}
