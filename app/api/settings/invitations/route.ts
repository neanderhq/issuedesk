import { and, count, eq, gt, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../../../server/db";
import { jsonError, parseJson, requireWorkspaceAccess, runRoute, validateMutation } from "../../../../server/http";
import { withWorkspaceLock } from "../../../../server/locks";
import { invitations, memberships, user } from "../../../../server/schema";
import { textInput } from "../../../../server/validation";

const invitationSchema = z.object({
  email: textInput(320).pipe(z.email()).transform((value) => value.toLowerCase()),
  role: textInput(6).pipe(z.enum(["Admin", "Member"])),
});

export async function POST(request: Request) {
  return runRoute("settings-invitation-create", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const parsed = await parseJson(request, invitationSchema);
    if ("response" in parsed) return parsed.response;
    return withWorkspaceLock(async () => {
      const db = getDb();
      const [existingMember] = await db.select({ id: memberships.id }).from(memberships)
        .innerJoin(user, eq(memberships.userId, user.id))
        .where(and(eq(memberships.workspaceId, access.membership.workspaceId), eq(user.email, parsed.data.email), eq(memberships.active, true))).limit(1);
      if (existingMember) return jsonError("This email is already an active member", 409);
      const [existingInvitation] = await db.select({ id: invitations.id }).from(invitations).where(and(
        eq(invitations.workspaceId, access.membership.workspaceId),
        eq(invitations.email, parsed.data.email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      )).limit(1);
      if (existingInvitation) return jsonError("A pending invitation already exists for this email", 409);
      const [activeCount] = await db.select({ value: count() }).from(memberships).where(and(eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true)));
      const [pendingCount] = await db.select({ value: count() }).from(invitations).where(and(
        eq(invitations.workspaceId, access.membership.workspaceId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ));
      if (activeCount.value + pendingCount.value >= 10) return jsonError("The workspace has reached its 10-member limit", 409);
      const token = randomBytes(32).toString("base64url");
      const [invitation] = await db.insert(invitations).values({
        workspaceId: access.membership.workspaceId,
        email: parsed.data.email,
        role: parsed.data.role,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }).returning({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt });
      const inviteUrl = new URL("/invite", request.headers.get("origin") || process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000");
      inviteUrl.searchParams.set("token", token);
      return Response.json({ invitation, inviteUrl: inviteUrl.toString() }, { status: 201 });
    });
  });
}
