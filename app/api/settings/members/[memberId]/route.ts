import { and, count, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { session as authSession } from "../../../../../server/auth-schema";
import { getDb } from "../../../../../server/db";
import { jsonError, parseJson, requireWorkspaceAccess, runRoute, validateMutation } from "../../../../../server/http";
import { withWorkspaceLock } from "../../../../../server/locks";
import { activity, invitations, issues, memberships } from "../../../../../server/schema";
import { textInput } from "../../../../../server/validation";

type RouteContext = { params: Promise<{ memberId: string }> };
const roleSchema = z.object({ role: textInput(6).pipe(z.enum(["Admin", "Member"])) });
const restoreSchema = z.object({ active: z.literal(true) }).strict();

async function memberIdFrom(context: RouteContext) {
  const params = await context.params;
  return z.uuid().safeParse(params.memberId);
}

export async function PATCH(request: Request, context: RouteContext) {
  return runRoute("settings-member-role", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const parsedId = await memberIdFrom(context);
    if (!parsedId.success) return jsonError("Member id is invalid", 400);
    const parsed = await parseJson(request, z.union([roleSchema, restoreSchema]));
    if ("response" in parsed) return parsed.response;
    return withWorkspaceLock(async () => {
      const db = getDb();
      if ("active" in parsed.data) {
        const [target] = await db.select({ id: memberships.id }).from(memberships).where(and(
          eq(memberships.id, parsedId.data),
          eq(memberships.workspaceId, access.membership.workspaceId),
          eq(memberships.active, false),
        )).limit(1);
        if (!target) return jsonError("Removed member not found", 404);
        const [activeCount] = await db.select({ value: count() }).from(memberships).where(and(
          eq(memberships.workspaceId, access.membership.workspaceId),
          eq(memberships.active, true),
        ));
        const [pendingCount] = await db.select({ value: count() }).from(invitations).where(and(
          eq(invitations.workspaceId, access.membership.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ));
        if (activeCount.value + pendingCount.value >= 10) return jsonError("The workspace has reached its 10-member limit", 409);
        const [updated] = await db.update(memberships).set({ active: true }).where(and(
          eq(memberships.id, target.id),
          eq(memberships.workspaceId, access.membership.workspaceId),
          eq(memberships.active, false),
        )).returning({ id: memberships.id, active: memberships.active });
        return Response.json(updated);
      }
      const [target] = await db.select().from(memberships).where(and(eq(memberships.id, parsedId.data), eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true))).limit(1);
      if (!target) return jsonError("Active member not found", 404);
      if (target.role === "Admin" && parsed.data.role === "Member") {
        const [adminCount] = await db.select({ value: count() }).from(memberships).where(and(eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true), eq(memberships.role, "Admin")));
        if (adminCount.value <= 1) return jsonError("The last Admin cannot be demoted", 409);
      }
      const [updated] = await db.update(memberships).set({ role: parsed.data.role }).where(eq(memberships.id, target.id)).returning({ id: memberships.id, role: memberships.role });
      return Response.json(updated);
    });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  return runRoute("settings-member-remove", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const parsedId = await memberIdFrom(context);
    if (!parsedId.success) return jsonError("Member id is invalid", 400);
    const parsedBody = await parseJson(request, z.object({}).strict());
    if ("response" in parsedBody) return parsedBody.response;
    return withWorkspaceLock(async () => {
      const db = getDb();
      const [target] = await db.select().from(memberships).where(and(eq(memberships.id, parsedId.data), eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true))).limit(1);
      if (!target) return jsonError("Active member not found", 404);
      if (target.role === "Admin") {
        const [adminCount] = await db.select({ value: count() }).from(memberships).where(and(eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true), eq(memberships.role, "Admin")));
        if (adminCount.value <= 1) return jsonError("The last Admin cannot be removed", 409);
      }
      await db.transaction(async (transaction) => {
        await transaction.update(memberships).set({ active: false }).where(eq(memberships.id, target.id));
        await transaction.delete(authSession).where(eq(authSession.userId, target.userId));
        const unassigned = await transaction.update(issues).set({
          assigneeId: null,
          version: sql`${issues.version} + 1`,
        }).where(and(
          eq(issues.workspaceId, access.membership.workspaceId),
          eq(issues.assigneeId, target.userId),
          ne(issues.status, "Done"),
          isNull(issues.archivedAt),
        )).returning({ id: issues.id, assigneeId: issues.assigneeId });
        if (unassigned.length) await transaction.insert(activity).values(unassigned.map((issue) => ({
          workspaceId: access.membership.workspaceId,
          issueId: issue.id,
          actorId: access.session.user.id,
          action: "unassigned",
          field: "assigneeId",
          previousValue: target.userId,
          nextValue: null,
        })));
      });
      return Response.json({ message: "Member removed" });
    });
  });
}
