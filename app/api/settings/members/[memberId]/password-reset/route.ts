import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createResetAuth } from "../../../../../../server/auth";
import { user } from "../../../../../../server/auth-schema";
import { getDb } from "../../../../../../server/db";
import { jsonError, parseJson, requireWorkspaceAccess, runRoute, validateMutation } from "../../../../../../server/http";
import { memberships, passwordResetRequests } from "../../../../../../server/schema";

type RouteContext = { params: Promise<{ memberId: string }> };

export async function POST(request: Request, context: RouteContext) {
  return runRoute("settings-member-password-reset", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const parsedBody = await parseJson(request, z.object({}).strict());
    if ("response" in parsedBody) return parsedBody.response;
    const { memberId } = await context.params;
    const parsedId = z.uuid().safeParse(memberId);
    if (!parsedId.success) return jsonError("Member id is invalid", 400);
    const [target] = await getDb().select({ email: user.email }).from(memberships)
      .innerJoin(user, eq(memberships.userId, user.id))
      .where(and(eq(memberships.id, parsedId.data), eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true))).limit(1);
    if (!target) return jsonError("Active member not found", 404);
    const origin = new URL(request.headers.get("origin") || process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000").origin;
    let resetLink = "";
    const resetAuth = createResetAuth(async (url, callbackToken) => {
      const betterAuthUrl = new URL(url);
      const token = callbackToken || betterAuthUrl.searchParams.get("token") || decodeURIComponent(betterAuthUrl.pathname.split("/").filter(Boolean).at(-1) || "");
      if (token) resetLink = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    });
    await resetAuth.api.requestPasswordReset({
      body: { email: target.email, redirectTo: new URL("/reset-password", origin).toString() },
    });
    if (!resetLink) return jsonError("Could not generate a password reset link", 500);
    await getDb().update(passwordResetRequests).set({ fulfilledAt: new Date() }).where(and(eq(passwordResetRequests.email, target.email), isNull(passwordResetRequests.fulfilledAt)));
    return Response.json({ resetLink, expiresInSeconds: 3600 });
  });
}
