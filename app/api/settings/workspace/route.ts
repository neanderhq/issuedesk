import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../server/db";
import { jsonError, parseJson, requireWorkspaceAccess, runRoute, validateMutation } from "../../../../server/http";
import { workspaces } from "../../../../server/schema";
import { textInput } from "../../../../server/validation";

export const dynamic = "force-dynamic";

const workspaceSchema = z.object({
  name: textInput(120, "Workspace name must be 120 characters or fewer").min(1, "Workspace name is required"),
  issueKeyPrefix: textInput(8).regex(/^[A-Z][A-Z0-9]{1,7}$/, "Prefix must be 2 to 8 uppercase letters or numbers"),
});

export async function GET(request: Request) {
  return runRoute("settings-workspace-read", async () => {
    const access = await requireWorkspaceAccess(request);
    if ("response" in access) return access.response;
    return Response.json({ workspace: { id: access.membership.workspaceId, name: access.membership.workspaceName, issueKeyPrefix: access.membership.issueKeyPrefix }, role: access.membership.role });
  });
}

export async function PUT(request: Request) {
  return runRoute("settings-workspace-update", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request, true);
    if ("response" in access) return access.response;
    const parsed = await parseJson(request, workspaceSchema);
    if ("response" in parsed) return parsed.response;
    const [workspace] = await getDb().update(workspaces).set(parsed.data).where(eq(workspaces.id, access.membership.workspaceId)).returning({ id: workspaces.id, name: workspaces.name, issueKeyPrefix: workspaces.issueKeyPrefix });
    return workspace ? Response.json({ workspace }) : jsonError("Workspace not found", 404);
  });
}
