import { notFound } from "next/navigation";
import { WorkspacePage } from "@/server/workspace-page";

export const dynamic = "force-dynamic";

export default async function SettingsSectionPage({ params }: { params: Promise<{ setting: string }> }) {
  const { setting } = await params;
  if (setting !== "members" && setting !== "workspace") notFound();
  return <WorkspacePage activePage={setting === "members" ? "settings-members" : "settings-workspace"} />;
}
