import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { runRoute, requireWorkspaceAccess } from "@/server/http";
import { workspaceChangeCursors } from "@/server/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runRoute("changes-get", async () => {
    const access = await requireWorkspaceAccess(request);
    if ("response" in access) return access.response;
    const [row] = await getDb().select({ cursor: workspaceChangeCursors.cursor })
      .from(workspaceChangeCursors)
      .where(eq(workspaceChangeCursors.workspaceId, access.membership.workspaceId))
      .limit(1);
    return Response.json({ cursor: String(row?.cursor ?? 0) });
  });
}
