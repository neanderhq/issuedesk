"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, Check, CheckCheck, Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePathname, useRouter } from "next/navigation";
import { AttioFramework, type AttioFrameworkModel, type FrameworkPage } from "../src/neander-design-pack/attio/2.0.0/AttioFramework";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { MembersSettings, WorkspaceSettings } from "@/components/workspace-settings";
import { authClient } from "@/app/auth-client";
import { IssueListPage } from "@/components/issues/issue-list";
import { IssueBoardPage } from "@/components/issues/issue-board";
import { IssueDetailPage } from "@/components/issues/issue-detail";
import { IssueArchivePage } from "@/components/issues/issue-archive";
import { SavedIssueView } from "@/components/issues/saved-issue-view";
import { ProjectsListPage } from "@/components/projects/projects-list";
import { ProjectDetailPage } from "@/components/projects/project-detail";
import { CyclesListPage } from "@/components/cycles/cycle-list";
import { CycleDetailPage } from "@/components/cycles/cycle-detail";
import { ApiError, requestJson } from "@/components/issues/issue-api";
import { formatDateTime } from "@/lib/date-format";
import type { SavedViewRecord } from "@/components/issues/issue-view-controls";
import { TemplateLibrary } from "@/components/templates/template-library";
import styles from "./team-tracker-shell.module.css";

type ShellProps = { activePage: string; issueIdentifier?: string; projectId?: string; cycleId?: string; savedViewId?: string; workspace: string; initials: string; name: string; email: string; userId: string; role: "Admin" | "Member" };

function RoutePage({ path, children }: { path: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (pathname !== path) router.push(path);
  }, [path, pathname, router]);
  return children;
}

function EmptyPage({ title, description }: { title: string; description: string }) {
  return <div className="mx-auto flex min-h-[58vh] w-full max-w-3xl flex-col px-4 py-6 sm:px-8">
    <div className="mb-8 flex justify-end"><ThemeToggle /></div>
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-muted text-muted-foreground" aria-hidden="true">···</div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  </div>;
}

type InboxNotification = { id: string; issueId: string | null; issueIdentifier: string | null; issueTitle: string | null; actorName: string | null; type: string; payload: Record<string, unknown>; readAt: string | null; createdAt: string };

function notificationText(notification: InboxNotification) {
  if (notification.type === "assigned") return `${notification.actorName ?? "A teammate"} assigned you to this issue`;
  if (notification.type === "mentioned") return `${notification.actorName ?? "A teammate"} mentioned you`;
  const action = String(notification.payload.action ?? "updated").replaceAll("_", " ");
  return `${notification.actorName ?? "A teammate"} ${action} an issue you follow`;
}

function LiveInboxPage({ refreshUnread }: { refreshUnread: () => void }) {
  const [rows, setRows] = useState<InboxNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await requestJson<{ notifications: InboxNotification[]; unreadCount: number }>("/api/notifications");
      setRows(result.notifications); setUnreadCount(result.unreadCount); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your inbox could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useLiveUpdates(load);
  useEffect(() => { void load(); }, [load]);

  async function markRead(id: string, read: boolean) {
    setSaving(true); setError("");
    try {
      await requestJson(`/api/notifications/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ read }) });
      await load(); refreshUnread();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The notification could not be updated."); }
    finally { setSaving(false); }
  }
  async function markAllRead() {
    setSaving(true); setError("");
    try {
      await requestJson("/api/notifications/read-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await load(); refreshUnread();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your inbox could not be marked read."); }
    finally { setSaving(false); }
  }
  const markNotificationRead = async (notification: InboxNotification) => {
    if (!notification.readAt) await markRead(notification.id, true);
    if (notification.issueIdentifier) window.location.assign(`/issue/${encodeURIComponent(notification.issueIdentifier)}`);
  };
  return <main className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-6 sm:px-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Inbox</h1><p className="mt-1 text-sm text-muted-foreground">{unreadCount ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}` : "You’re all caught up."}</p></div><Button variant="outline" disabled={saving || unreadCount === 0} onClick={() => void markAllRead()}><CheckCheck />Mark all read</Button></header>
    {error && <Alert variant="destructive"><AlertTitle>Inbox needs attention</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{error}<Button size="xs" variant="outline" onClick={() => { setLoading(true); void load(); }}>Try again</Button></AlertDescription></Alert>}
    {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading notifications…</div> : rows.length ? <ol className="grid gap-2">{rows.map((notification) => <li key={notification.id}><Card className={notification.readAt ? "bg-card" : "border-primary/40 bg-primary/5"}><CardContent className="flex min-w-0 items-start gap-3 p-4"><button type="button" aria-label={`Open notification for ${notification.issueIdentifier ?? "issue"}`} className="min-w-0 flex-1 text-left" onClick={() => void markNotificationRead(notification)}><span className="flex items-center gap-2 text-sm font-medium">{notification.readAt ? <CircleCheck className="size-4 text-muted-foreground" /> : <Circle className="size-4 fill-primary text-primary" />}{notificationText(notification)}</span><span className="mt-1 block break-words text-sm text-muted-foreground">{notification.issueIdentifier ? `${notification.issueIdentifier}${notification.issueTitle ? ` · ${notification.issueTitle}` : ""}` : "Issue no longer available"}</span><time className="mt-2 block text-xs text-muted-foreground" dateTime={notification.createdAt}>{formatDateTime(notification.createdAt)}</time></button><Button size="icon-sm" variant="ghost" aria-label={notification.readAt ? "Mark unread" : "Mark read"} disabled={saving} onClick={() => void markRead(notification.id, !notification.readAt)}>{notification.readAt ? <Bell /> : <Check />}</Button></CardContent></Card></li>)}</ol> : <Card><CardContent className="grid justify-items-center gap-2 py-16 text-center"><Bell className="size-8 text-muted-foreground" /><h2 className="font-medium">All caught up</h2><p className="max-w-sm text-sm text-muted-foreground">Notifications for assignments, mentions and followed issues will show up here.</p></CardContent></Card>}
  </main>;
}

function SettingsPage({ section, role, name, email }: Pick<ShellProps, "role" | "name" | "email"> & { section: "members" | "workspace" }) {
  return <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8">
    <div className="mb-6 flex justify-end"><ThemeToggle /></div>
    <p className="mb-5 text-sm text-muted-foreground">{section === "members" ? "Manage people and invitations for your workspace." : "Update your shared workspace details."}</p>
    <Card><CardContent className="pt-6">{section === "members" ? <MembersSettings role={role} /> : <WorkspaceSettings role={role} name={name} email={email} />}</CardContent></Card>
  </div>;
}

export function TeamTrackerShell({ activePage, issueIdentifier, projectId, cycleId, savedViewId, workspace, initials, name, email, userId, role }: ShellProps) {
  const router = useRouter();
  const [savedViews, setSavedViews] = useState<SavedViewRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const refreshUnread = useCallback(async () => {
    try { const result = await requestJson<{ unreadCount: number }>("/api/notifications/unread-count"); setUnreadCount(result.unreadCount); } catch { /* Keep the last known badge during transient network errors. */ }
  }, []);
  useLiveUpdates(refreshUnread);
  useEffect(() => { void refreshUnread(); }, [refreshUnread]);
  useEffect(() => {
    const loadSavedViews = () => {
      void requestJson<{ savedViews: SavedViewRecord[] }>("/api/saved-views").then((response) => setSavedViews(response.savedViews)).catch(() => setSavedViews([]));
    };
    loadSavedViews();
    window.addEventListener("saved-views-changed", loadSavedViews);
    return () => window.removeEventListener("saved-views-changed", loadSavedViews);
  }, []);
  const pages = useMemo<FrameworkPage[]>(() => [
    ...(issueIdentifier ? ([{ id: "issue", label: "Issue", icon: "bolt", title: issueIdentifier, content: <RoutePage path={`/issue/${encodeURIComponent(issueIdentifier)}`}><IssueDetailPage identifier={issueIdentifier} userId={userId} /></RoutePage> }] satisfies FrameworkPage[]) : []),
    { id: "inbox", layout: "editor", label: "Inbox", icon: "mail", title: "Inbox", badge: unreadCount || undefined, content: <RoutePage path="/inbox"><LiveInboxPage refreshUnread={() => { void refreshUnread(); }} /></RoutePage> },
    { id: "my-issues", layout: "editor", label: "My Issues", icon: "task", title: "My Issues", content: <RoutePage path="/my-issues"><IssueListPage view="my-issues" userId={userId} /></RoutePage> },
    { id: "backlog", layout: "editor", label: "Backlog", icon: "clock", title: "Backlog", content: <RoutePage path="/backlog"><IssueListPage view="backlog" userId={userId} /></RoutePage> },
    { id: "board", label: "Board", icon: "grid", title: "Board", content: <RoutePage path="/board"><IssueBoardPage /></RoutePage> },
    { id: "list", layout: "editor", label: "List", icon: "grid", title: "List", content: <RoutePage path="/list"><IssueListPage view="list" userId={userId} /></RoutePage> },
    ...savedViews.map((savedView) => ({
      id: `saved-view-${savedView.id}`,
      label: savedView.name,
      layout: savedView.layout === "List" ? "editor" as const : "page" as const,
      icon: "grid" as const,
      title: savedView.name,
      content: <RoutePage path={`/saved-views/${encodeURIComponent(savedView.id)}`}><SavedIssueView viewId={savedView.id} userId={userId} /></RoutePage>,
    })),
    { id: "projects", label: "Projects", icon: "folder", title: "Projects", content: <RoutePage path={projectId ? `/projects/${encodeURIComponent(projectId)}` : "/projects"}>{projectId ? <ProjectDetailPage projectId={projectId} /> : <ProjectsListPage />}</RoutePage> },
    { id: "cycles", layout: "editor", label: "Cycles", icon: "clock", title: "Cycles", content: <RoutePage path={cycleId ? `/cycles/${encodeURIComponent(cycleId)}` : "/cycles"}>{cycleId ? <CycleDetailPage key={cycleId} cycleId={cycleId} /> : <CyclesListPage />}</RoutePage> },
    { id: "archive", layout: "editor", label: "Archive", icon: "folder", title: "Archive", content: <RoutePage path="/archive"><IssueArchivePage /></RoutePage> },
    { id: "templates", layout: "editor", label: "Issue templates", icon: "folder", title: "Issue templates", content: <RoutePage path="/templates"><TemplateLibrary role={role} /></RoutePage> },
    { id: "settings-members", label: "Members", icon: "people", title: "Members", content: <RoutePage path="/settings/members"><SettingsPage section="members" role={role} name={name} email={email} /></RoutePage> },
    { id: "settings-workspace", label: "Workspace", icon: "settings", title: "Workspace", content: <RoutePage path="/settings/workspace"><SettingsPage section="workspace" role={role} name={name} email={email} /></RoutePage> },
  ], [email, name, role, userId, issueIdentifier, projectId, cycleId, savedViews, unreadCount, refreshUnread]);
  const model: AttioFrameworkModel = { workspace, initials, objects: [], pages };
  const resolvedActivePage = savedViewId ? `saved-view-${savedViewId}` : activePage;
  return <div className={styles.shell}><AttioFramework key={resolvedActivePage} model={model} initialPage={`page:${resolvedActivePage}`} signOutConfirmationText="You will need to sign in again to use this workspace." actions={{
    openInbox: () => router.push("/inbox"),
    signOut: async () => {
    const result = await authClient.signOut();
    if (!result.error) window.location.assign("/login");
    return !result.error;
  },
  }} /></div>;
}
