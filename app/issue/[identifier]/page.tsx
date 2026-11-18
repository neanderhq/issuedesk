import { WorkspacePage } from "@/server/workspace-page";

export const dynamic = "force-dynamic";

export default async function IssuePage({ params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  return <WorkspacePage activePage="issue" issueIdentifier={identifier} />;
}
