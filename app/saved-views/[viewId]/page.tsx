import { WorkspacePage } from "@/server/workspace-page";

export const dynamic = "force-dynamic";

export default async function SavedViewPage({ params }: { params: Promise<{ viewId: string }> }) {
  const { viewId } = await params;
  return <WorkspacePage activePage={`saved-view-${viewId}`} savedViewId={viewId} />;
}
