import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../server/db";
import { jsonError, parseJson, requireWorkspaceAccess, runRoute, validateMutation } from "../../../../../server/http";
import { invitations } from "../../../../../server/schema";

type RouteContext = { params: Promise<{ invitationId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  return runRoute("settings-invitation-revoke", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const parsedBody = await parseJson(request, z.object({}).strict());
    if ("response" in parsedBody) return parsedBody.response;
    const { invitationId } = await context.params;
    const parsedId = z.uuid().safeParse(invitationId);
    if (!parsedId.success) return jsonError("Invitation id is invalid", 400);
    const [revoked] = await getDb().update(invitations).set({ revokedAt: new Date() }).where(and(
      eq(invitations.id, parsedId.data),
      eq(invitations.workspaceId, access.membership.workspaceId),
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
    )).returning({ id: invitations.id });
    return revoked ? Response.json({ message: "Invitation revoked" }) : jsonError("Pending invitation not found", 404);
  });
}
