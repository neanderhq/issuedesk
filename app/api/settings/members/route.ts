import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../server/db";
import { requireWorkspaceAccess, runRoute } from "../../../../server/http";
import { invitations, memberships, passwordResetRequests, user } from "../../../../server/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runRoute("settings-members", async () => {
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const db = getDb();
    const members = await db.select({ id: memberships.id, userId: user.id, name: user.name, email: user.email, role: memberships.role, active: memberships.active, createdAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(user, eq(memberships.userId, user.id))
      .where(eq(memberships.workspaceId, access.membership.workspaceId))
      .orderBy(desc(memberships.createdAt));
    const pendingInvitations = await db.select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
      .from(invitations)
      .where(and(eq(invitations.workspaceId, access.membership.workspaceId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const resetRequests = await db.select({ id: passwordResetRequests.id, email: passwordResetRequests.email, createdAt: passwordResetRequests.createdAt })
      .from(passwordResetRequests)
      .where(isNull(passwordResetRequests.fulfilledAt))
      .orderBy(desc(passwordResetRequests.createdAt));
    return Response.json({ members, invitations: pendingInvitations.filter((item) => item.expiresAt > new Date()), resetRequests });
  });
}
