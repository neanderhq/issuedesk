import { requireWorkspaceAccess, runRoute } from "../../../server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runRoute("me", async () => {
    const access = await requireWorkspaceAccess(request);
    if ("response" in access) return access.response;
    return Response.json({
      user: { id: access.session.user.id, name: access.session.user.name, email: access.session.user.email },
      workspace: { id: access.membership.workspaceId, name: access.membership.workspaceName, issueKeyPrefix: access.membership.issueKeyPrefix },
      role: access.membership.role,
    });
  });
}
