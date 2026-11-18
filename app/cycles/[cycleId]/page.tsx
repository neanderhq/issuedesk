import { WorkspacePage } from "@/server/workspace-page";

export const dynamic = "force-dynamic";

export default async function CyclePage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await params;
  return <WorkspacePage activePage="cycles" cycleId={cycleId} />;
}
