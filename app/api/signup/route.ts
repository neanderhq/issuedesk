import { and, count, eq, gt, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getAuth } from "../../../server/auth";
import { user } from "../../../server/auth-schema";
import { getDb } from "../../../server/db";
import { jsonError, runRoute, validateMutation } from "../../../server/http";
import { withWorkspaceLock } from "../../../server/locks";
import { seedProductLaunch } from "../../../server/seed-product-launch.mjs";
import { invitations, memberships, workspaces } from "../../../server/schema";
import { passwordInput, textInput } from "../../../server/validation";

const signupSchema = z.object({
  name: textInput(120, "Name must be 120 characters or fewer").min(1, "Name is required"),
  email: textInput(320).pipe(z.email()).transform((value) => value.toLowerCase()),
  password: passwordInput(),
  invitationToken: textInput(200).min(32).optional(),
});

export async function POST(request: Request) {
  return runRoute("signup", async () => {
    const invalidMutation = await validateMutation(request);
    if (invalidMutation) return invalidMutation;
    let value: unknown;
    try {
      value = JSON.parse(await request.text());
    } catch {
      return jsonError("Request body must be valid JSON", 400);
    }
    const parsed = signupSchema.safeParse(value);
    if (!parsed.success) return jsonError(parsed.error.issues[0].message, 400);
    return withWorkspaceLock(async () => {
      const input = parsed.data;
      const db = getDb();
      const [workspace] = await db.select().from(workspaces).limit(1);
      let invitation: typeof invitations.$inferSelect | undefined;
      if (input.invitationToken) {
        const tokenHash = createHash("sha256").update(input.invitationToken).digest("hex");
        [invitation] = await db.select().from(invitations).where(and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        )).limit(1);
        if (!invitation || invitation.email !== input.email || !workspace || invitation.workspaceId !== workspace.id) {
          return jsonError("Invitation is invalid, expired, or belongs to another email address", 400);
        }
      } else {
        const [userCount] = await db.select({ value: count() }).from(user);
        if (workspace || userCount.value > 0) return jsonError("A valid invitation is required to join this workspace", 403);
      }
      const [activeCount] = await db.select({ value: count() }).from(memberships).where(eq(memberships.active, true));
      const [pendingCount] = await db.select({ value: count() }).from(invitations).where(and(
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ));
      if (activeCount.value + pendingCount.value > 10) return jsonError("The workspace has reached its 10-member limit", 409);
      const authUrl = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000";
      const authResponse = await getAuth().handler(new Request(new URL("/api/auth/sign-up/email", authUrl), {
        method: "POST",
        headers: { "content-type": "application/json", origin: request.headers.get("origin") || "" },
        body: JSON.stringify({ name: input.name, email: input.email, password: input.password }),
      }));
      const authBody = await authResponse.text();
      if (!authResponse.ok) return new Response(authBody, { status: authResponse.status, headers: authResponse.headers });
      let authResult: { user?: { id?: string } };
      try {
        authResult = JSON.parse(authBody);
      } catch {
        return jsonError("Could not complete account creation", 500);
      }
      const userId = authResult.user?.id;
      if (!userId) return jsonError("Could not complete account creation", 500);
      try {
        await db.transaction(async (transaction) => {
          let workspaceId = workspace?.id;
          let role: "Admin" | "Member" = "Admin";
          if (invitation) {
            const [accepted] = await transaction.update(invitations).set({ acceptedAt: new Date() }).where(and(
              eq(invitations.id, invitation.id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              gt(invitations.expiresAt, new Date()),
            )).returning({ workspaceId: invitations.workspaceId, role: invitations.role });
            if (!accepted) throw new Error("Invitation was already used or expired");
            workspaceId = accepted.workspaceId;
            role = accepted.role;
          } else {
            const [createdWorkspace] = await transaction.insert(workspaces).values({ name: "Team Tracker" }).returning({ id: workspaces.id });
            workspaceId = createdWorkspace.id;
          }
          if (!workspaceId) throw new Error("Workspace could not be created");
          await transaction.insert(memberships).values({ workspaceId, userId, role, active: true });
          if (!invitation) await seedProductLaunch(transaction, workspaceId, userId);
        });
      } catch (error) {
        await db.delete(user).where(eq(user.id, userId));
        throw error;
      }
      return new Response(authBody, { status: authResponse.status, headers: authResponse.headers });
    });
  });
}
