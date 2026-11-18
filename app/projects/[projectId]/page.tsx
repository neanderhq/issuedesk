import { WorkspacePage } from "@/server/workspace-page";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <WorkspacePage activePage="projects" projectId={projectId} />;
}
