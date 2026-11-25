import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TeamTrackerShell } from "@/components/team-tracker-shell";
import { getAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { memberships, workspaces } from "@/server/schema";

export const workspacePages = [
  "issue",
  "inbox",
  "my-issues",
  "backlog",
  "board",
  "list",
  "projects",
  "cycles",
  "archive",
  "templates",
  "settings-members",
  "settings-workspace",
] as const;

export type WorkspacePageKey = typeof workspacePages[number];

export async function WorkspacePage({ activePage, issueIdentifier, projectId, cycleId, savedViewId }: { activePage: WorkspacePageKey | `saved-view-${string}`; issueIdentifier?: string; projectId?: string; cycleId?: string; savedViewId?: string }) {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const [access] = await getDb().select({ role: memberships.role, workspaceName: workspaces.name })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(and(eq(memberships.userId, session.user.id), eq(memberships.active, true)))
    .limit(1);
  if (!access) redirect("/login");

  const initials = access.workspaceName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "T";
  return <TeamTrackerShell
    activePage={activePage}
    issueIdentifier={issueIdentifier}
    projectId={projectId}
    cycleId={cycleId}
    savedViewId={savedViewId}
    workspace={access.workspaceName}
    initials={initials}
    name={session.user.name}
    email={session.user.email}
    userId={session.user.id}
    role={access.role}
  />;
}
