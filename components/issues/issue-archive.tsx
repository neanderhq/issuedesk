"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, AlertCircle, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { IssueBulkActions } from "./issue-bulk-actions";
import { getArchivedIssues, restoreIssue, type IssueRecord } from "./issue-api";
import { formatDate } from "@/lib/date-format";

function archivedDate(value: string | null) {
  return value ? formatDate(value) : "";
}

export function IssueArchivePage() {
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setIssues(await getArchivedIssues());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Archived issues could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function restore(issue: IssueRecord) {
    setRestoringId(issue.id);
    setError("");
    try {
      await restoreIssue(issue);
      setIssues((current) => current.filter((item) => item.id !== issue.id));
      setSelectedIds((current) => current.filter((id) => id !== issue.id));
      setSuccess(`${issue.identifier} was restored to active issues.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The issue could not be restored.");
    } finally {
      setRestoringId(null);
    }
  }

  return <main className="mx-auto grid w-full min-w-0 max-w-5xl gap-5 px-3 py-5 sm:px-6 sm:py-7">
    <header className="grid min-w-0 gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Archive className="size-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-2xl font-semibold tracking-tight">Archive</h2>
      </div>
      <p className="text-sm text-muted-foreground">Archived issues are hidden from your workspace views. Restore an issue to bring it back.</p>
    </header>

    {error && <Alert variant="destructive"><AlertCircle /><AlertTitle>Could not update the archive</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{error}<Button size="xs" variant="outline" onClick={() => void load()}><RotateCw />Try again</Button></AlertDescription></Alert>}
    {success && <Alert><ArchiveRestore /><AlertTitle>Issue restored</AlertTitle><AlertDescription>{success}</AlertDescription></Alert>}

    {loading ? <div className="grid gap-2" aria-label="Loading archived issues"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      : error && !issues.length ? null : issues.length ? <>
        <IssueBulkActions
          visibleIssues={issues}
          selectedIssues={issues.filter((issue) => selectedIds.includes(issue.id)).map(({ id, version }) => ({ id, version }))}
          members={[]}
          projects={[]}
          labels={[]}
          busy={bulkBusy || restoringId !== null}
          onBusyChange={setBulkBusy}
          onSelectAll={(selected) => setSelectedIds(selected ? issues.map((issue) => issue.id) : [])}
          onUpdated={(updated) => {
            const restoredIds = new Set(updated.map((issue) => issue.id));
            setIssues((current) => current.filter((issue) => !restoredIds.has(issue.id)));
            setSelectedIds((current) => current.filter((id) => !restoredIds.has(id)));
            setSuccess(`${updated.length} ${updated.length === 1 ? "issue was" : "issues were"} restored to active issues.`);
            void load();
          }}
          onClearSelection={() => setSelectedIds([])}
          archivedMode
        />
        <ul className="grid min-w-0 gap-2" aria-label="Archived issues">{issues.map((issue) => <li key={issue.id} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex min-w-0 items-start gap-3">
            <Checkbox checked={selectedIds.includes(issue.id)} disabled={bulkBusy || restoringId !== null} onCheckedChange={(checked) => setSelectedIds((current) => checked === true ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id))} aria-label={`Select ${issue.identifier}`} className="mt-0.5" />
            <div className="grid min-w-0 gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
                <Link href={`/issue/${encodeURIComponent(issue.identifier)}`} className="min-w-0 break-words font-medium [overflow-wrap:anywhere] hover:underline">{issue.title}</Link>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{issue.status}</Badge>
                {issue.priority !== "No priority" && <Badge variant="secondary">{issue.priority}</Badge>}
                {issue.labels.map((label) => <Badge key={label.id} variant="outline">{label.name}</Badge>)}
                <span>Archived {archivedDate(issue.archivedAt)}</span>
              </div>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" className="w-full shrink-0 sm:w-auto" disabled={restoringId !== null || bulkBusy} onClick={() => void restore(issue)}>
            <ArchiveRestore />{restoringId === issue.id ? "Restoring…" : "Restore"}
          </Button>
        </li>)}</ul>
      </>
        : <section className="grid min-h-52 place-content-center justify-items-center gap-2 rounded-lg border border-dashed p-6 text-center">
          <Archive className="size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="font-medium">Nothing archived</h2>
          <p className="max-w-sm text-sm text-muted-foreground">Issues you archive will appear here. Their details and history remain saved.</p>
        </section>}
  </main>;
}
