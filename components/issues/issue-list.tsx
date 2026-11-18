"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, CircleDot, Pencil, RotateCw, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, getIssue, getIssues, issuePriorities, issueStatuses, moveIssue, optimisticallyMoveIssue, requestJson, updateIssueField, type CreatedIssue, type IssueCycleOption, type IssueEditableField, type IssueFieldValue, type IssueLabelOption, type IssueMember, type IssueMilestone, type IssueMovePlacement, type IssuePriority, type IssueProject, type IssueRecord, type IssueStatus } from "./issue-api";
import { IssueMoveControl } from "./issue-move-control";
import { IssueBulkActions } from "./issue-bulk-actions";
import { NewIssueDialog } from "./new-issue-dialog";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { IssueViewControls, type SavedViewRecord } from "./issue-view-controls";
import { hasIssueFilters, type IssueFilters } from "./issue-filters";
import { useIssueFilters } from "./use-issue-filters";
import { IssueCsvActions } from "./issue-csv-actions";
import { formatDate as formatDateOnly } from "@/lib/date-format";

type MutationResult = { ok: true } | { ok: false; message: string; conflict: boolean };
type Drafts = Partial<Record<IssueEditableField, string | number | null>>;
type IssueListView = "backlog" | "list" | "my-issues";

type IssueRowProps = {
  issue: IssueRecord;
  assigneeName?: string;
  projectName?: string;
  milestoneName?: string;
  parentIssue?: IssueRecord;
  members: IssueMember[];
  selected: boolean;
  selectionDisabled: boolean;
  onSelect: (issueId: string, selected: boolean) => void;
  issues: IssueRecord[];
  moveDisabled: boolean;
  onMove: (issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) => Promise<boolean>;
  onSave: (field: IssueEditableField, value: IssueFieldValue, version: number) => Promise<MutationResult>;
  onReload: () => Promise<void>;
};

function formatDate(date: string) {
  return formatDateOnly(date);
}

function IssueRow({ issue, assigneeName, projectName, milestoneName, parentIssue, members, selected, selectionDisabled, onSelect, issues, moveDisabled, onMove, onSave, onReload }: IssueRowProps) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [retry, setRetry] = useState<{ field: IssueEditableField; value: IssueFieldValue } | null>(null);
  const draftVersion = useRef(issue.version);

  const title = typeof drafts.title === "string" ? drafts.title : issue.title;
  const description = typeof drafts.description === "string" ? drafts.description : issue.description;
  const status = typeof drafts.status === "string" ? drafts.status as IssueStatus : issue.status;
  const priority = typeof drafts.priority === "string" ? drafts.priority as IssuePriority : issue.priority;
  const assigneeId = Object.prototype.hasOwnProperty.call(drafts, "assigneeId") ? String(drafts.assigneeId ?? "none") : issue.assigneeId ?? "none";
  const dueDate = Object.prototype.hasOwnProperty.call(drafts, "dueDate") ? String(drafts.dueDate ?? "") : issue.dueDate ?? "";
  const estimate = drafts.estimate !== undefined ? String(drafts.estimate ?? "") : issue.estimate === null ? "" : String(issue.estimate);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = Boolean(dueDate && dueDate < today && status !== "Done");

  async function save(field: IssueEditableField, value: IssueFieldValue) {
    if (!Object.keys(drafts).length) draftVersion.current = issue.version;
    setDrafts((current) => ({ ...current, [field]: value }));
    setSaving(true);
    setConflict(false);
    setSaveError("");
    setRetry({ field, value });
    const result = await onSave(field, value, draftVersion.current);
    setSaving(false);
    if (result.ok) {
      setRetry(null);
      draftVersion.current += 1;
      setDrafts((current) => { const next = { ...current }; delete next[field]; return next; });
      return true;
    }
    setConflict(result.conflict);
    setSaveError(result.message);
    return false;
  }

  async function reload() {
    setSaving(true);
    try {
      await onReload();
    } finally {
      setSaving(false);
    }
  }

  async function saveTitle() {
    if (title.trim() && title !== issue.title && await save("title", title.trim())) setEditingTitle(false);
    else if (!title.trim()) setSaveError("Title is required.");
    else if (title === issue.title) setEditingTitle(false);
  }

  async function saveDescription() {
    if (await save("description", description)) setEditingDescription(false);
  }

  return <article className="grid min-w-0 gap-2 border-b px-3 py-3 last:border-b-0 sm:px-4" aria-label={`${issue.identifier}: ${issue.title}`}>
    <div className="flex min-w-0 items-start gap-2">
      <Checkbox checked={selected} disabled={selectionDisabled} onCheckedChange={(checked) => onSelect(issue.id, checked === true)} aria-label={`Select ${issue.identifier}`} className="mt-0.5 size-9 rounded-md p-2" />
      <Link href={`/issue/${encodeURIComponent(issue.identifier)}`} className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground hover:underline">{issue.identifier}</Link>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-1">
          {editingTitle ? <Input
            aria-label={`Edit title for ${issue.identifier}`}
            autoFocus
            maxLength={200}
            value={title}
            disabled={saving}
            onChange={(event) => setDrafts((current) => ({ ...current, title: event.target.value }))}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") { setDrafts((current) => { const next = { ...current }; delete next.title; return next; }); setEditingTitle(false); }
            }}
            className="h-7 min-w-0 flex-1 px-2 py-1 text-sm font-medium"
          /> : <p className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{issue.title}</p>}
          {!editingTitle && <Button variant="ghost" size="icon-xs" aria-label={`Edit title for ${issue.identifier}`} disabled={saving} onClick={() => { draftVersion.current = issue.version; setDrafts((current) => ({ ...current, title: issue.title })); setEditingTitle(true); }}><Pencil /></Button>}
        </div>
        {editingDescription ? <div className="mt-2 grid gap-2">
          <Textarea aria-label={`Edit description for ${issue.identifier}`} value={description} maxLength={20000} disabled={saving} onChange={(event) => setDrafts((current) => ({ ...current, description: event.target.value }))} className="min-h-16 break-all [overflow-wrap:anywhere]" />
          <div className="flex flex-wrap gap-2">
            <Button size="xs" disabled={saving} onClick={() => void saveDescription()}>{saving ? "Saving…" : "Save description"}</Button>
            <Button size="xs" variant="ghost" disabled={saving} onClick={() => { setDrafts((current) => { const next = { ...current }; delete next.description; return next; }); setEditingDescription(false); }}><X />Cancel</Button>
          </div>
        </div> : <div className="mt-0.5 flex min-w-0 items-start gap-1">
          {description ? <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{issue.description}</p> : <span className="text-xs text-muted-foreground">No description</span>}
          <Button variant="ghost" size="icon-xs" aria-label={`Edit description for ${issue.identifier}`} disabled={saving} onClick={() => { draftVersion.current = issue.version; setDrafts((current) => ({ ...current, description: issue.description })); setEditingDescription(true); }}><Pencil /></Button>
        </div>}
      </div>
    </div>

    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-0 sm:pl-[4.5rem]">
      <Select value={status} disabled={saving} onValueChange={(value) => void save("status", value)}>
        <SelectTrigger aria-label={`Status for ${issue.identifier}`} className="h-7 w-auto min-w-24 border-transparent bg-transparent px-1.5 text-xs shadow-none hover:bg-accent"><CircleDot /><SelectValue /></SelectTrigger>
        <SelectContent>{issueStatuses.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={priority} disabled={saving} onValueChange={(value) => void save("priority", value)}>
        <SelectTrigger aria-label={`Priority for ${issue.identifier}`} className="h-7 w-auto min-w-24 border-transparent bg-transparent px-1.5 text-xs shadow-none hover:bg-accent"><SelectValue /></SelectTrigger>
        <SelectContent>{issuePriorities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={assigneeId} disabled={saving} onValueChange={(value) => void save("assigneeId", value === "none" ? null : value)}>
        <SelectTrigger aria-label={`Assignee for ${issue.identifier}`} className="h-7 w-auto min-w-24 max-w-full border-transparent bg-transparent px-1.5 text-xs shadow-none hover:bg-accent"><SelectValue placeholder="Unassigned" /></SelectTrigger>
        <SelectContent><SelectItem value="none">Unassigned</SelectItem>{members.filter((member) => member.active).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent>
      </Select>
      <label className={`flex h-7 items-center gap-1 rounded-md px-1.5 focus-within:ring-2 focus-within:ring-ring ${overdue ? "text-destructive" : "text-muted-foreground"}`}>
        <span className="sr-only">Due date for {issue.identifier}</span>
        <Input type="date" aria-label={`Due date for ${issue.identifier}`} value={dueDate} disabled={saving} onFocus={() => { if (!Object.keys(drafts).length) draftVersion.current = issue.version; }} onChange={(event) => setDrafts((current) => ({ ...current, dueDate: event.target.value }))} onBlur={(event) => {
          const value = event.currentTarget.value || null;
          if (value !== issue.dueDate) void save("dueDate", value);
        }} className={`h-6 w-[8.5rem] border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 ${overdue ? "text-destructive" : ""}`} />
      </label>
      <label className="flex h-7 items-center gap-1 text-xs text-muted-foreground">
        <span>Est.</span>
        <Input type="number" min={0} max={100} step={1} aria-label={`Estimate for ${issue.identifier}`} value={estimate} disabled={saving} onFocus={() => { if (!Object.keys(drafts).length) draftVersion.current = issue.version; }} onChange={(event) => setDrafts((current) => ({ ...current, estimate: event.target.value }))} onBlur={(event) => {
          const raw = event.currentTarget.value;
          const value = raw === "" ? null : Number(raw);
          if (value !== issue.estimate) void save("estimate", value);
        }} className="h-6 w-12 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0" />
      </label>
    </div>

    <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-0 sm:pl-[4.5rem]">
      {assigneeName && <span className="sr-only">Assigned to {assigneeName}</span>}
      {projectName && <Badge variant="outline" className="max-w-full whitespace-normal break-words">{projectName}</Badge>}
      {milestoneName && <Badge variant="secondary" className="max-w-full whitespace-normal break-words">{milestoneName}</Badge>}
      {parentIssue && <Badge variant="outline" className="max-w-full whitespace-normal break-words">Parent {parentIssue.identifier}: {parentIssue.title}</Badge>}
      {issue.labels.map((label) => <Badge key={label.id} variant="secondary" className="max-w-full whitespace-normal break-words">{label.name}</Badge>)}
      {issue.dueDate && <span className={`text-xs ${overdue ? "text-destructive" : "text-muted-foreground"}`}>Due {formatDate(issue.dueDate)}</span>}
    </div>

    <div className="pl-0 sm:pl-[4.5rem]"><IssueMoveControl issue={issue} issues={issues} disabled={moveDisabled || saving} onMove={onMove} /></div>

    {(conflict || saveError) && <Alert variant={conflict ? "destructive" : "default"} className="ml-0 min-w-0 py-2 sm:ml-[4.5rem]">
      <AlertCircle />
      <AlertTitle>{conflict ? "Someone else changed this" : saveError}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {conflict ? <><span>Your edit is still here. Reload to see the latest saved version.</span><Button variant="outline" size="xs" onClick={() => void reload()} disabled={saving}><RotateCw />Reload issue</Button></> : retry && <Button variant="outline" size="xs" onClick={() => void save(retry.field, retry.value)} disabled={saving}>Try again</Button>}
      </AlertDescription>
    </Alert>}
  </article>;
}

function CompactIssueRow({ issue, assigneeName, projectName, issues, moveDisabled, selected, selectionDisabled, onSelect, onMove }: {
  issue: IssueRecord;
  assigneeName?: string;
  projectName?: string;
  issues: IssueRecord[];
  moveDisabled: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onSelect: (issueId: string, selected: boolean) => void;
  onMove: IssueRowProps["onMove"];
}) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = Boolean(issue.dueDate && issue.dueDate < today && issue.status !== "Done");

  return <div className="grid min-w-0 gap-1.5 border-b px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4">
    <div className="flex min-w-0 items-start gap-2">
      <Checkbox checked={selected} disabled={selectionDisabled} onCheckedChange={(checked) => onSelect(issue.id, checked === true)} aria-label={`Select ${issue.identifier}`} className="size-9 rounded-md p-2" />
      <Link href={`/issue/${encodeURIComponent(issue.identifier)}`} className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground hover:underline">{issue.identifier}</Link>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{issue.title}</p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          {projectName && <span className="max-w-full break-all text-xs text-muted-foreground">{projectName}</span>}
          {issue.labels.map((label) => <Badge key={label.id} variant="secondary" className="max-w-full whitespace-normal break-all text-xs">{label.name}</Badge>)}
        </div>
      </div>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-[3.5rem] text-xs sm:justify-end sm:pl-0">
      <span className="text-muted-foreground">{issue.priority}</span>
      <span className="max-w-full break-all text-muted-foreground">{assigneeName ?? "Unassigned"}</span>
      {issue.dueDate && <span className={overdue ? "text-destructive" : "text-muted-foreground"}>Due {formatDate(issue.dueDate)}</span>}
      <IssueMoveControl issue={issue} issues={issues} disabled={moveDisabled} onMove={onMove} />
    </div>
  </div>;
}

export function IssueListPage({ view, savedView, canManageSavedView, onSavedViewChange }: { view: IssueListView; userId: string; savedView?: SavedViewRecord; canManageSavedView?: boolean; onSavedViewChange?: (view: SavedViewRecord | null) => void }) {
  const initialFilters = useMemo(() => (savedView?.filters ?? {}) as IssueFilters, [savedView?.filters]);
  const [filters, setFilters] = useIssueFilters(initialFilters, Boolean(savedView));
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [members, setMembers] = useState<IssueMember[]>([]);
  const [projects, setProjects] = useState<IssueProject[]>([]);
  const [milestones, setMilestones] = useState<IssueMilestone[]>([]);
  const [labels, setLabels] = useState<IssueLabelOption[]>([]);
  const [cycles, setCycles] = useState<IssueCycleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [metadataError, setMetadataError] = useState("");
  const [moveError, setMoveError] = useState("");
  const [movingIssueId, setMovingIssueId] = useState<string | null>(null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [bulkPending, setBulkPending] = useState(false);
  const scope = view === "backlog" ? "backlog" : view === "my-issues" ? "mine" : "all";

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const issueRows = await getIssues(filters, scope);
      setIssues(issueRows);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Issues could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters, scope]);

  const loadMetadata = useCallback(async () => {
    try {
      const [memberResponse, projectResponse, milestoneResponse, labelResponse, cycleResponse] = await Promise.all([
        requestJson<{ members: IssueMember[] }>("/api/members"),
        requestJson<{ projects: IssueProject[] }>("/api/projects"),
        requestJson<{ milestones: IssueMilestone[] }>("/api/milestones"),
        requestJson<{ labels: IssueLabelOption[] }>("/api/labels"),
        requestJson<{ cycles: IssueCycleOption[] }>("/api/cycles"),
      ]);
      setMembers(memberResponse.members);
      setProjects(projectResponse.projects);
      setMilestones(milestoneResponse.milestones);
      setLabels(labelResponse.labels);
      setCycles(cycleResponse.cycles);
      setMetadataError("");
    } catch {
      setMetadataError("Issues loaded, but some supporting details could not be loaded. Try again.");
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([load(), loadMetadata()]);
  }, [load, loadMetadata]);

  useLiveUpdates(refresh);

  useEffect(() => {
    const timer = window.setTimeout(() => { setLoading(true); void load(); }, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => { void loadMetadata(); }, [loadMetadata]);

  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const milestoneById = useMemo(() => new Map(milestones.map((milestone) => [milestone.id, milestone.name])), [milestones]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);
  const activeIssues = issues.filter((issue) => !issue.archivedAt);
  const listedIssues = activeIssues;
  const selectedIssues = listedIssues.filter((issue) => selectedIssueIds.includes(issue.id));
  const title = view === "backlog" ? "Backlog" : view === "my-issues" ? "My Issues" : "List";
  const description = view === "backlog"
    ? "Unplanned work for your team."
    : view === "my-issues"
      ? "Work assigned to you across every status."
      : "All active issues, grouped by status.";

  async function saveField(issue: IssueRecord, field: IssueEditableField, value: IssueFieldValue, version: number): Promise<MutationResult> {
    try {
      const updated = await updateIssueField({ ...issue, version }, field, value);
      setIssues((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      return { ok: true };
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) return { ok: false, message: "Someone else changed this", conflict: true };
      return { ok: false, message: cause instanceof Error ? cause.message : "The change could not be saved.", conflict: false };
    }
  }

  async function reloadIssue(issueId: string) {
    try {
      const current = await getIssue(issueId);
      setIssues((rows) => rows.map((row) => row.id === issueId ? current : row));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "The latest issue could not be loaded.");
    }
  }

  async function moveListIssue(issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) {
    if (movingIssueId) return false;
    const previous = issues;
    setMoveError("");
    setMovingIssueId(issue.id);
    setIssues(optimisticallyMoveIssue(issues, issue.id, status, placement, relativeIssueId));
    try {
      await moveIssue(issue, status, placement, relativeIssueId);
      try {
        setIssues(await getIssues(filters, scope));
      } catch {
        setMoveError("The move was saved, but the latest order could not be refreshed. Refresh this page to verify it.");
      }
      return true;
    } catch (cause) {
      setIssues(previous);
      setMoveError(cause instanceof ApiError
        ? `The move could not be saved: ${cause.message}. Your issue was put back.`
        : "Could not reach the server. Your move was reverted; check your connection and try again.");
      return false;
    } finally {
      setMovingIssueId(null);
    }
  }

  function selectIssue(issueId: string, selected: boolean) {
    setSelectedIssueIds((current) => selected
      ? current.includes(issueId) ? current : [...current, issueId]
      : current.filter((id) => id !== issueId));
  }

  function addCreatedIssue(created: CreatedIssue) {
    const normalized: IssueRecord = {
      ...created,
      labels: created.labels.map((id) => labels.find((label) => label.id === id)).filter((label): label is IssueLabelOption => Boolean(label)),
    };
    setIssues((rows) => [normalized, ...rows]);
  }

  return <section className="mx-auto w-full min-w-0 max-w-6xl px-3 py-5 sm:px-6 sm:py-7">
    <div className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 break-words text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {view === "list" && <IssueCsvActions filters={filters} onImported={load} />}
        <NewIssueDialog
          members={members}
          projects={projects}
          milestones={milestones}
          labels={labels}
          parentIssues={issues}
          onCreated={addCreatedIssue}
        />
      </div>
    </div>

    <IssueViewControls filters={filters} onFiltersChange={setFilters} layout="List" savedView={savedView} canManageSavedView={canManageSavedView} onSavedViewChange={onSavedViewChange} />

    {loadError && <Alert variant="destructive" className="mb-4 min-w-0">
      <AlertCircle /><AlertTitle>Could not load issues</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span className="break-words">{loadError}</span><Button size="xs" variant="outline" onClick={() => { setLoading(true); void load(); }}><RotateCw />Try again</Button></AlertDescription>
    </Alert>}

    {metadataError && <Alert variant="destructive" className="mb-4 min-w-0">
      <AlertCircle /><AlertTitle>Some issue details are unavailable</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span className="break-words">{metadataError}</span><Button size="xs" variant="outline" onClick={() => { setLoading(true); void load(); }}><RotateCw />Try again</Button></AlertDescription>
    </Alert>}

    {moveError && <Alert variant="destructive" className="mb-4 min-w-0"><AlertCircle /><AlertTitle>Issue move needs attention</AlertTitle><AlertDescription className="break-words">{moveError}</AlertDescription></Alert>}

    {!loading && !loadError && <IssueBulkActions
      visibleIssues={listedIssues}
      selectedIssues={selectedIssues.map(({ id, version }) => ({ id, version }))}
      members={members}
      projects={projects}
      milestones={milestones}
      labels={labels}
      cycles={cycles}
      busy={bulkPending}
      onBusyChange={setBulkPending}
      onSelectAll={(selected) => setSelectedIssueIds(selected ? listedIssues.map((issue) => issue.id) : [])}
      onUpdated={(updatedIssues) => {
        const updatedById = new Map(updatedIssues.map((issue) => [issue.id, issue]));
        setIssues((current) => current.map((issue) => updatedById.get(issue.id) ?? issue));
        void load();
      }}
      onCycleChange={() => { void load(); }}
      onClearSelection={() => setSelectedIssueIds([])}
    />}

    <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5 sm:px-4">
        <CircleDot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 break-words text-sm font-medium">{view === "list" ? "Issues by status" : title}</h2>
        {!loading && <Badge variant="secondary">{listedIssues.length}</Badge>}
      </div>
      {loading ? <div className="grid gap-4 p-4" aria-label="Loading issues">
        {[0, 1, 2].map((item) => <div key={item} className="grid gap-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-6 w-1/2" /></div>)}
      </div> : !listedIssues.length && !loadError ? <div className="flex min-h-56 flex-col items-center justify-center px-5 py-10 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full border bg-muted text-muted-foreground"><CircleDot className="size-5" /></div>
        <h3 className="text-base font-medium">{hasIssueFilters(filters) ? "No issues match these filters" : view === "backlog" ? "Your backlog is clear" : view === "my-issues" ? "No issues assigned to you" : "No issues yet"}</h3>
        <p className="mt-1 max-w-sm break-words text-sm text-muted-foreground">{hasIssueFilters(filters) ? "Try changing a filter or clear them to see all matching work." : view === "backlog" ? "Create an issue to capture work your team plans to do later." : view === "my-issues" ? "Issues assigned to you will appear here." : "Create an issue to start tracking your team's work."}</p>
        {hasIssueFilters(filters) && <Button variant="outline" className="mt-4" onClick={() => setFilters({})}>Clear filters</Button>}
      </div> : view === "list" ? <div className="divide-y">
        {issueStatuses.map((status) => {
          const group = activeIssues.filter((issue) => issue.status === status);
          return <section key={status} className="min-w-0" aria-label={`${status}: ${group.length} issues`}>
            <div className="flex min-w-0 items-center gap-2 bg-muted/40 px-3 py-2 sm:px-4">
              <h3 className="min-w-0 break-words text-xs font-semibold">{status}</h3>
              <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{group.length}</Badge>
            </div>
            {group.length ? group.map((issue) => <CompactIssueRow
              key={issue.id}
              issue={issue}
              assigneeName={issue.assigneeId ? memberById.get(issue.assigneeId) : undefined}
              projectName={issue.projectId ? projectById.get(issue.projectId) : undefined}
              issues={issues}
              moveDisabled={Boolean(movingIssueId)}
              selected={selectedIssueIds.includes(issue.id)}
              selectionDisabled={bulkPending}
              onSelect={selectIssue}
              onMove={moveListIssue}
            />) : <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No {status.toLowerCase()} issues.</p>}
          </section>;
        })}
      </div> : listedIssues.length ? listedIssues.map((issue) => <IssueRow
        key={issue.id}
        issue={issue}
        assigneeName={issue.assigneeId ? memberById.get(issue.assigneeId) : undefined}
        projectName={issue.projectId ? projectById.get(issue.projectId) : undefined}
        milestoneName={issue.milestoneId ? milestoneById.get(issue.milestoneId) : undefined}
        parentIssue={issue.parentIssueId ? issueById.get(issue.parentIssueId) : undefined}
        members={members}
        selected={selectedIssueIds.includes(issue.id)}
        selectionDisabled={bulkPending}
        onSelect={selectIssue}
        issues={issues}
        moveDisabled={Boolean(movingIssueId)}
        onMove={moveListIssue}
        onSave={(field, value, version) => saveField(issue, field, value, version)}
        onReload={() => reloadIssue(issue.id)}
      />) : null}
    </div>
  </section>;
}
