import { count, eq } from "drizzle-orm";
import { runRoute } from "../../../server/http";
import { getDb } from "../../../server/db";
import { user } from "../../../server/auth-schema";
import { workspaces } from "../../../server/schema";

export const dynamic = "force-dynamic";


export async function GET() {
  return runRoute("registration-status", async () => {
    const [workspaceCount] = await getDb().select({ value: count() }).from(workspaces);
    const [userCount] = await getDb().select({ value: count() }).from(user);
    return Response.json({ bootstrapAllowed: workspaceCount.value === 0 && userCount.value === 0 });
  });
}
