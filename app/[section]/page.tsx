import { notFound } from "next/navigation";
import { WorkspacePage, workspacePages } from "@/server/workspace-page";

export const dynamic = "force-dynamic";

const pageByPath: Record<string, typeof workspacePages[number]> = {
  inbox: "inbox",
  "my-issues": "my-issues",
  backlog: "backlog",
  board: "board",
  list: "list",
  projects: "projects",
  cycles: "cycles",
  archive: "archive",
};

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const activePage = pageByPath[section];
  if (!activePage) notFound();
  return <WorkspacePage activePage={activePage} />;
}
