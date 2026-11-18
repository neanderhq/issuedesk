"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, CalendarDays, Check, CircleDot, RotateCw, UserRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AttioTable } from "@/src/neander-design-pack/attio/2.0.0/AttioBlocks";
import { AttioCard, AttioGrid, AttioInline, AttioPage, AttioSection, AttioStack, AttioStat, AttioStats } from "@/src/neander-design-pack/attio/2.0.0/AttioLayouts";
import { ApiError, getIssues, requestJson, type IssueProject, type IssueRecord } from "@/components/issues/issue-api";
import { addDays, cycleRange, formatCycleTimestamp, type CycleDetail, type CycleIssue, type CycleMetric, type CycleRecord } from "./cycle-api";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";

type CycleDraft = { name: string; goal: string; startDate: string; endDate: string };

function jsonRequest(body: unknown) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function IssueLink({ issue }: { issue: Pick<CycleIssue, "identifier" | "title"> }) {
  return <Link className="min-w-0 break-words font-medium text-primary hover:underline" href={`/issue/${encodeURIComponent(issue.identifier)}`}>{issue.identifier}: {issue.title}</Link>;
}

function MetricValue({ metric }: { metric: CycleMetric }) {
  return <span>{metric.issueCount} issues · {metric.estimatePoints} pts</span>;
}

function MetricCard({ label, metric }: { label: string; metric: CycleMetric }) {
  return <AttioStat label={label} value={metric.issueCount} detail={`${metric.estimatePoints} estimate points`} />;
}

function IssueRow({ issue, checked, disabled, onCheckedChange, action }: {
  issue: CycleIssue;
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  action?: ReactNode;
}) {
  return <div className="flex min-w-0 flex-wrap items-center gap-3 border-b py-3 last:border-0">
    {onCheckedChange && <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} aria-label={`Select ${issue.identifier}`} />}
    <div className="min-w-0 flex-1 basis-48"><div className="flex min-w-0 flex-wrap items-center gap-2"><IssueLink issue={issue} /><span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{issue.status}</span>{issue.priority !== "No priority" && <span className="text-xs text-muted-foreground">{issue.priority}</span>}</div><p className="mt-1 text-xs text-muted-foreground">{issue.assigneeName || "Unassigned"} · {issue.estimate === null ? "Unestimated" : `${issue.estimate} pts`}</p></div>
    {action && <div className="flex shrink-0 gap-2">{action}</div>}
  </div>;
}

function SnapshotList({ title, issues, empty }: { title: string; issues: CycleIssue[]; empty: string }) {
  return <AttioCard padding={4}>
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{title}</h3><span className="rounded-full border px-2 py-0.5 text-xs">{issues.length}</span></div>
    {issues.length ? <div>{issues.map((issue) => <IssueRow key={issue.id} issue={issue} />)}</div> : <p className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">{empty}</p>}
  </AttioCard>;
}

export function CycleDetailPage({ cycleId }: { cycleId: string }) {
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [cycles, setCycles] = useState<CycleRecord[]>([]);
  const [projects, setProjects] = useState<IssueProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<CycleDraft>({ name: "", goal: "", startDate: "", endDate: "" });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [unfinishedAction, setUnfinishedAction] = useState<"carry" | "backlog">("carry");
  const [planSource, setPlanSource] = useState("backlog");
  const [planIssues, setPlanIssues] = useState<IssueRecord[]>([]);
  const [planSelected, setPlanSelected] = useState<string[]>([]);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const [issueSelection, setIssueSelection] = useState<string[]>([]);
  const [issueTarget, setIssueTarget] = useState("backlog");
  const [mutationMessage, setMutationMessage] = useState("");
  const [conflict, setConflict] = useState<{ current: CycleRecord; changes: Partial<CycleDraft>; conflicting: string[] } | null>(null);
  const draftInitializedFor = useRef<string | null>(null);
  const draftVersion = useRef<number | null>(null);
  const draftActive = useRef(false);
  const draftBase = useRef<CycleDraft | null>(null);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [nextDetail, cycleResponse, projectResponse] = await Promise.all([
        requestJson<CycleDetail>(`/api/cycles/${encodeURIComponent(cycleId)}`),
        requestJson<{ cycles: CycleRecord[] }>("/api/cycles"),
        requestJson<{ projects: IssueProject[] }>("/api/projects"),
      ]);
      if (!draftActive.current) {
        draftVersion.current = nextDetail.cycle.version;
        draftBase.current = { name: nextDetail.cycle.name, goal: nextDetail.cycle.goal ?? "", startDate: nextDetail.cycle.startDate, endDate: nextDetail.cycle.endDate };
      }
      setDetail({
        ...nextDetail,
        cycle: {
          ...nextDetail.cycle,
          version: draftActive.current ? draftVersion.current ?? nextDetail.cycle.version : nextDetail.cycle.version,
        },
      });
      setCycles(cycleResponse.cycles);
      setProjects(projectResponse.projects);
      if (draftInitializedFor.current !== cycleId) {
        setDraft({ name: nextDetail.cycle.name, goal: nextDetail.cycle.goal ?? "", startDate: nextDetail.cycle.startDate, endDate: nextDetail.cycle.endDate });
        setIssueSelection([]);
        draftInitializedFor.current = cycleId;
      }
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "The cycle could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [cycleId]);

  useLiveUpdates(load);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const cycle = detail?.cycle;
  const readOnly = cycle?.status === "Completed";
  const planCycleOptions = useMemo(() => cycles.filter((item) => item.id !== cycleId && item.status !== "Completed"), [cycles, cycleId]);

  function markDraftChanged() {
    if (!draftActive.current) {
      draftVersion.current = cycle?.version ?? null;
      draftBase.current = cycle ? { name: cycle.name, goal: cycle.goal ?? "", startDate: cycle.startDate, endDate: cycle.endDate } : null;
      draftActive.current = true;
    }
  }

  useEffect(() => {
    if (!cycle || cycle.status === "Completed") return;
    let active = true;
    setPlanLoading(true);
    setPlanError("");
    const query = planSource === "backlog"
      ? getIssues({}, "backlog")
      : planSource.startsWith("project:")
        ? getIssues({ projectId: planSource.slice("project:".length) })
        : Promise.resolve([] as IssueRecord[]);
    void query.then((issues) => {
      if (!active) return;
      setPlanIssues(issues.filter((issue) => !issue.archivedAt && issue.cycleId !== cycleId));
      setPlanSelected([]);
    }).catch((cause) => {
      if (active) setPlanError(cause instanceof Error ? cause.message : "Project issues could not be loaded.");
    }).finally(() => { if (active) setPlanLoading(false); });
    return () => { active = false; };
  }, [cycle, cycleId, planSource]);

  async function saveCycle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cycle || readOnly) return;
    const fields: Partial<CycleDraft> = {};
    if (draft.name !== cycle.name) fields.name = draft.name;
    if ((draft.goal || null) !== cycle.goal) fields.goal = draft.goal;
    if (draft.startDate !== cycle.startDate) fields.startDate = draft.startDate;
    if (draft.endDate !== cycle.endDate) fields.endDate = draft.endDate;
    if (!Object.keys(fields).length) return;
    setSaving(true);
    setActionError("");
    try {
      await requestJson<CycleRecord>(`/api/cycles/${encodeURIComponent(cycle.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, ...(fields.goal === undefined ? {} : { goal: fields.goal || null }), version: draftVersion.current ?? cycle.version }),
      });
      draftActive.current = false;
      setMutationMessage("Cycle details saved.");
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.current && typeof cause.current === "object" && "version" in cause.current) {
        const current = cause.current as CycleRecord;
        const base = draftBase.current ?? cycle as unknown as CycleDraft;
        const conflicting = Object.keys(fields).filter((field) => !Object.is((current as unknown as Record<string, unknown>)[field], field === "goal" ? base.goal || null : base[field as keyof CycleDraft]));
        setDetail((previous) => previous ? { ...previous, cycle: { ...previous.cycle, ...current, version: draftActive.current ? draftVersion.current ?? current.version : current.version } } : previous);
        if (!conflicting.length) {
          const safeFields = Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, field === "goal" ? value || null : value]));
          void requestJson<CycleRecord>(`/api/cycles/${encodeURIComponent(current.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...safeFields, version: current.version }) }).then(() => { draftActive.current = false; draftBase.current = null; setMutationMessage("Cycle details saved."); void load(); }).catch((retryError) => setActionError(retryError instanceof Error ? retryError.message : "Cycle details could not be saved."));
        } else setConflict({ current, changes: fields as Partial<CycleDraft>, conflicting });
        setActionError("");
      } else setActionError(cause instanceof Error ? cause.message : "Cycle details could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function resolveCycleConflict(keepMine: boolean) {
    if (!conflict) return;
    const pending = conflict; setConflict(null);
    const changes: Record<string, string | null> = {};
    for (const [field, value] of Object.entries(pending.changes)) {
      if (!pending.conflicting.includes(field) || keepMine) changes[field] = (field === "goal" ? value || null : value) as string | null;
    }
    if (!Object.keys(changes).length) { draftActive.current = false; draftBase.current = null; draftVersion.current = pending.current.version; setDraft({ name: pending.current.name, goal: pending.current.goal ?? "", startDate: pending.current.startDate, endDate: pending.current.endDate }); await load(); return; }
    setSaving(true); setActionError("");
    try {
      await requestJson<CycleRecord>(`/api/cycles/${encodeURIComponent(pending.current.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...changes, version: pending.current.version }) });
      draftActive.current = false; draftBase.current = null; setMutationMessage("Cycle details saved."); await load();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Cycle details could not be saved."); }
    finally { setSaving(false); }
  }

  async function startCycle() {
    if (!cycle || cycle.status !== "Upcoming") return;
    setSaving(true);
    setActionError("");
    try {
      await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/start`, jsonRequest({ version: cycle.version }));
      setMutationMessage("Cycle started.");
      await load();
    } catch (cause) {
      setActionError(cause instanceof ApiError && cause.status === 409
        ? "This cycle could not start because it changed or another cycle is already active. Reload to see the latest status."
        : cause instanceof Error ? cause.message : "The cycle could not be started.");
    } finally {
      setSaving(false);
    }
  }

  async function closeCycle() {
    if (!cycle || cycle.status !== "Active") return;
    setSaving(true);
    setActionError("");
    try {
      await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/close`, jsonRequest({ version: cycle.version, unfinishedAction }));
      setCloseOpen(false);
      setMutationMessage(unfinishedAction === "carry" ? "Cycle closed; unfinished work was carried forward." : "Cycle closed; unfinished work returned to the backlog.");
      await load();
    } catch (cause) {
      setActionError(cause instanceof ApiError && cause.status === 409
        ? "This cycle changed or is no longer active. Reload to see the latest status."
        : cause instanceof Error ? cause.message : "The cycle could not be closed.");
    } finally {
      setSaving(false);
    }
  }

  async function refreshPlanner() {
    if (!cycle || !planSource) return;
    setPlanLoading(true);
    setPlanError("");
    try {
      const issues = planSource === "backlog"
        ? await getIssues({}, "backlog")
        : await getIssues({ projectId: planSource.slice("project:".length) });
      setPlanIssues(issues.filter((issue) => !issue.archivedAt && issue.cycleId !== cycle.id));
      setPlanSelected([]);
    } catch (cause) {
      setPlanError(cause instanceof Error ? cause.message : "Project issues could not be refreshed.");
    } finally {
      setPlanLoading(false);
    }
  }

  async function addPlannerIssue(issue: IssueRecord) {
    if (!cycle || readOnly || saving) return;
    setSaving(true);
    setPlanError("");
    try {
      const membership = [{ id: issue.id, version: issue.version }];
      if (!issue.cycleId) {
        await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/issues`, jsonRequest({ issues: membership }));
      } else {
        await requestJson(`/api/cycles/${encodeURIComponent(issue.cycleId)}/move`, jsonRequest({ targetCycleId: cycle.id, issues: membership }));
      }
      setMutationMessage(issue.cycleId ? `${issue.identifier} moved into this cycle.` : `${issue.identifier} added to this cycle.`);
      await Promise.all([load(), refreshPlanner()]);
    } catch (cause) {
      setPlanError(cause instanceof ApiError && cause.status === 409
        ? "This issue or cycle changed. Refresh the list and try again."
        : cause instanceof Error ? cause.message : "The issue could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function addSelectedIssues() {
    if (!cycle || readOnly || saving || !planSelected.length) return;
    const selected = planIssues.filter((issue) => planSelected.includes(issue.id) && !issue.cycleId);
    if (!selected.length) return;
    setSaving(true);
    setPlanError("");
    try {
      await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/issues`, jsonRequest({ issues: selected.map(({ id, version }) => ({ id, version })) }));
      setMutationMessage(`${selected.length} issue${selected.length === 1 ? "" : "s"} added to this cycle.`);
      await load();
      await refreshPlanner();
    } catch (cause) {
      setPlanError(cause instanceof ApiError && cause.status === 409
        ? "Some selected issues changed or are no longer in the backlog. Refresh the list and try again."
        : cause instanceof Error ? cause.message : "The selected issues could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function applyIssueMove() {
    if (!cycle || readOnly || saving || !issueSelection.length) return;
    const selected = detail?.issues.filter((issue) => issueSelection.includes(issue.id)) ?? [];
    if (!selected.length) return;
    setSaving(true);
    setActionError("");
    try {
      const membership = selected.map(({ id, version }) => ({ id, version }));
      if (issueTarget === "backlog") {
        await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/issues`, { ...jsonRequest({ issues: membership }), method: "DELETE" });
        setMutationMessage(`${selected.length} issue${selected.length === 1 ? "" : "s"} returned to the backlog.`);
      } else {
        await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/move`, jsonRequest({ targetCycleId: issueTarget, issues: membership }));
        const target = cycles.find((item) => item.id === issueTarget);
        setMutationMessage(`${selected.length} issue${selected.length === 1 ? "" : "s"} moved to ${target?.name ?? "another cycle"}.`);
      }
      await load();
    } catch (cause) {
      setActionError(cause instanceof ApiError && cause.status === 409
        ? "One or more issues changed or the destination cycle is no longer available. Refresh the cycle before trying again."
        : cause instanceof Error ? cause.message : "The issue move could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function removeIssueFromCycle(issue: CycleIssue) {
    if (!cycle || readOnly || saving) return;
    setSaving(true);
    setActionError("");
    try {
      await requestJson(`/api/cycles/${encodeURIComponent(cycle.id)}/issues`, {
        ...jsonRequest({ issues: [{ id: issue.id, version: issue.version }] }),
        method: "DELETE",
      });
      setMutationMessage(`${issue.identifier} returned to the backlog.`);
      await load();
    } catch (cause) {
      setActionError(cause instanceof ApiError && cause.status === 409
        ? "This issue changed or the cycle is no longer editable. Reload and try again."
        : cause instanceof Error ? cause.message : "The issue could not be removed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <AttioPage width="wide"><AttioStack><Skeleton className="h-10 w-1/3" /><Skeleton className="h-36 w-full" /><Skeleton className="h-64 w-full" /></AttioStack></AttioPage>;
  if (loadError || !detail || !cycle) return <AttioPage width="wide"><AttioStack><Button asChild variant="ghost" className="w-fit"><Link href="/cycles"><ArrowLeft />Back to cycles</Link></Button><Alert variant="destructive"><AlertCircle /><AlertTitle>{loadError ? "Could not load cycle" : "Cycle not found"}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{loadError || "This cycle may have been removed."}{loadError && <Button type="button" size="sm" variant="outline" onClick={() => { setLoading(true); void load(); }}><RotateCw />Try again</Button>}</AlertDescription></Alert></AttioStack></AttioPage>;

  const currentCycleIssues = detail.issues;
  const hasIssueSelection = issueSelection.length > 0;
  const eligiblePlanIssues = planIssues.filter((issue) => !issue.cycleId);
  const allPlanSelected = eligiblePlanIssues.length > 0 && eligiblePlanIssues.every((issue) => planSelected.includes(issue.id));

  return <AttioPage width="wide" title={cycle.name} description={<span className="inline-flex flex-wrap items-center gap-2"><CalendarDays className="size-4" />{cycleRange(cycle)}<span className="rounded-full border px-2 py-0.5 text-xs">{cycle.status}</span></span>} actions={<AttioInline>
    <Button asChild variant="outline"><Link href="/cycles"><ArrowLeft />All cycles</Link></Button>
    {cycle.status === "Upcoming" && <Button type="button" disabled={saving} onClick={() => void startCycle()}>Start cycle</Button>}
    {cycle.status === "Active" && <Button type="button" disabled={saving} onClick={() => { setActionError(""); setCloseOpen(true); }}>Close cycle</Button>}
  </AttioInline>}>
    <AttioStack>
      {(actionError || mutationMessage) && <Alert variant={actionError ? "destructive" : "default"}>{actionError ? <AlertCircle /> : <Check />}<AlertTitle>{actionError ? "Action needs attention" : "Saved"}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{actionError || mutationMessage}{actionError && <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => { setLoading(true); void load(); }}><RotateCw />Reload cycle</Button>}{mutationMessage && <Button type="button" size="sm" variant="ghost" onClick={() => setMutationMessage("")}>Dismiss</Button>}</AlertDescription></Alert>}

      <AttioGrid columns={2}>
        <AttioCard padding={4}>
          <form className="grid gap-3" onSubmit={(event) => void saveCycle(event)}>
            <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Cycle details</h2>{readOnly && <span className="text-xs text-muted-foreground">Completed cycles are read-only</span>}</div>
            <div className="grid gap-2"><Label htmlFor="cycle-detail-name">Name</Label><Input id="cycle-detail-name" value={draft.name} maxLength={120} disabled={readOnly || saving} onChange={(event) => { markDraftChanged(); setDraft({ ...draft, name: event.target.value }); }} /></div>
            <div className="grid gap-2"><Label htmlFor="cycle-detail-goal">Goal</Label><Textarea id="cycle-detail-goal" value={draft.goal} maxLength={4000} disabled={readOnly || saving} onChange={(event) => { markDraftChanged(); setDraft({ ...draft, goal: event.target.value }); }} placeholder="What should the team accomplish?" /></div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="cycle-detail-start">Start date</Label><Input id="cycle-detail-start" type="date" value={draft.startDate} disabled={readOnly || saving} onChange={(event) => { markDraftChanged(); setDraft((current) => ({ ...current, startDate: event.target.value, endDate: current.endDate === addDays(current.startDate, 14) ? addDays(event.target.value, 14) : current.endDate })); }} /></div><div className="grid gap-2"><Label htmlFor="cycle-detail-end">End date</Label><Input id="cycle-detail-end" type="date" min={draft.startDate} value={draft.endDate} disabled={readOnly || saving} onChange={(event) => { markDraftChanged(); setDraft({ ...draft, endDate: event.target.value }); }} /></div></div>
            {!readOnly && <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">Two-week default; dates may be adjusted.</span><Button type="submit" variant="outline" disabled={saving || !draft.name.trim() || !draft.startDate || !draft.endDate || draft.startDate > draft.endDate}>{saving ? "Saving…" : "Save details"}</Button></div>}
          </form>
        </AttioCard>
        <AttioCard padding={4}>
          <AttioSection title="Progress" description="Counts include unestimated issues as zero estimate points.">
            <AttioStats><MetricCard label="Scope" metric={detail.stats.scope} /><MetricCard label="Completed" metric={detail.stats.completed} /><MetricCard label="Remaining" metric={detail.stats.remaining} /><MetricCard label="Blocked" metric={detail.stats.blocked} /></AttioStats>
            <p className="mt-3 text-xs text-muted-foreground">{detail.stats.unestimatedIssueCount} unestimated issue{detail.stats.unestimatedIssueCount === 1 ? "" : "s"}</p>
          </AttioSection>
        </AttioCard>
      </AttioGrid>

      <AttioSection title="By assignee" description="Issue count and estimate points for each person.">
        {detail.stats.assignees.length ? <>
          <div className="grid gap-2 md:hidden">{detail.stats.assignees.map((assignee) => <AttioCard key={assignee.assigneeId ?? "unassigned"} padding={3}>
            <p className="mb-2 flex items-center gap-2 font-medium"><UserRound className="size-4 text-muted-foreground" />{assignee.assigneeName}</p><div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs"><span className="text-muted-foreground">Scope</span><MetricValue metric={assignee.scope} /><span className="text-muted-foreground">Completed</span><MetricValue metric={assignee.completed} /><span className="text-muted-foreground">Remaining</span><MetricValue metric={assignee.remaining} /><span className="text-muted-foreground">Blocked</span><MetricValue metric={assignee.blocked} /><span className="text-muted-foreground">Unestimated</span><span>{assignee.unestimatedIssueCount}</span></div>
          </AttioCard>)}</div>
          <div className="hidden overflow-x-auto rounded-lg border md:block"><AttioTable headers={["Assignee", "Scope", "Completed", "Remaining", "Blocked", "Unestimated"]} rows={detail.stats.assignees.map((assignee) => ({ key: assignee.assigneeId ?? "unassigned", cells: [assignee.assigneeName, <MetricValue key="scope" metric={assignee.scope} />, <MetricValue key="completed" metric={assignee.completed} />, <MetricValue key="remaining" metric={assignee.remaining} />, <MetricValue key="blocked" metric={assignee.blocked} />, assignee.unestimatedIssueCount] }))} /></div>
        </> : <AttioCard padding={4}><p className="text-sm text-muted-foreground">Issues assigned to people will be broken down here. Unassigned work appears once it is added to the cycle.</p></AttioCard>}
      </AttioSection>

      {detail.snapshot && <AttioSection title="Cycle snapshot" description="A record of the work when this cycle closed, even if issue status changes later.">
        <AttioGrid columns={2}><SnapshotList title="Completed" issues={detail.snapshot.completed} empty="No issues were completed in this cycle." /><SnapshotList title="Unfinished" issues={detail.snapshot.unfinished} empty="No unfinished issues remained when this cycle closed." /></AttioGrid>
        <div className="mt-4"><SnapshotList title="Carried over" issues={detail.snapshot.carriedOver} empty="No issues were carried into another cycle." /></div>
      </AttioSection>}

      <AttioSection title="Issues" description={readOnly ? "The issue list reflects the completed cycle snapshot." : "Work currently included in this cycle."} actions={!readOnly && currentCycleIssues.length > 0 ? <AttioInline>
        <Select value={issueTarget} disabled={saving || !hasIssueSelection} onValueChange={setIssueTarget}><SelectTrigger className="min-w-40"><SelectValue placeholder="Move selected" /></SelectTrigger><SelectContent><SelectItem value="backlog">Return to backlog</SelectItem>{planCycleOptions.map((item) => <SelectItem key={item.id} value={item.id}>Move to {item.name}</SelectItem>)}</SelectContent></Select>
        <Button type="button" variant="outline" disabled={saving || !hasIssueSelection} onClick={() => void applyIssueMove()}>Move selected ({issueSelection.length})</Button>
      </AttioInline> : undefined}>
        {!readOnly && currentCycleIssues.length > 0 && <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={currentCycleIssues.every((issue) => issueSelection.includes(issue.id))} disabled={saving} onCheckedChange={(value) => setIssueSelection(value === true ? currentCycleIssues.map((issue) => issue.id) : [])} />Select all issues</label>}
        <AttioCard padding={4}>
          {currentCycleIssues.length ? currentCycleIssues.map((issue) => <IssueRow key={issue.id} issue={issue} checked={issueSelection.includes(issue.id)} disabled={readOnly || saving} onCheckedChange={readOnly ? undefined : (checked) => setIssueSelection((current) => checked ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id))} action={!readOnly ? <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void removeIssueFromCycle(issue)}>Remove</Button> : undefined} />) : <div className="flex flex-col items-center gap-2 py-10 text-center"><CircleDot className="size-7 text-muted-foreground" /><p className="font-medium">No issues in this cycle</p><p className="max-w-md text-sm text-muted-foreground">Plan work from the backlog or a project below.</p></div>}
        </AttioCard>
      </AttioSection>

      {!readOnly && <AttioSection title="Plan issues" description="Add backlog work or move an issue from another cycle. Use checkboxes to add backlog issues in bulk." actions={<Select value={planSource} disabled={saving} onValueChange={setPlanSource}><SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="backlog">Backlog</SelectItem>{projects.map((project) => <SelectItem key={project.id} value={`project:${project.id}`}>{project.name}{project.archivedAt ? " (archived)" : ""}</SelectItem>)}</SelectContent></Select>}>
        {planError && <Alert variant="destructive" className="mb-3"><AlertCircle /><AlertTitle>Planning needs attention</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{planError}<Button type="button" size="sm" variant="outline" disabled={saving || planLoading} onClick={() => void refreshPlanner()}><RotateCw />Refresh issues</Button></AlertDescription></Alert>}
        {!planLoading && !planError && eligiblePlanIssues.length > 0 && <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={allPlanSelected} disabled={saving} onCheckedChange={(value) => setPlanSelected(value === true ? eligiblePlanIssues.map((issue) => issue.id) : [])} />Select backlog issues ({planSelected.length})</label>
          <Button type="button" size="sm" disabled={saving || !planSelected.length || planSelected.length > 100} onClick={() => void addSelectedIssues()}>{saving ? "Adding…" : `Add selected${planSelected.length ? ` (${planSelected.length})` : ""}`}</Button>
        </div>}
        <AttioCard padding={4}>
          {planLoading ? <div className="grid gap-3" aria-label="Loading project issues"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : planError ? <p className="py-4 text-sm text-muted-foreground">Refresh the issue list to continue planning.</p> : planIssues.length ? planIssues.map((issue) => {
            const source = issue.cycleId ? cycles.find((item) => item.id === issue.cycleId) : null;
            const canMove = Boolean(source && source.status !== "Completed");
            return <div key={issue.id} className="flex min-w-0 flex-wrap items-center gap-3 border-b py-3 last:border-0">
              {!issue.cycleId && <Checkbox checked={planSelected.includes(issue.id)} disabled={saving} onCheckedChange={(value) => setPlanSelected((current) => value === true ? [...new Set([...current, issue.id])] : current.filter((id) => id !== issue.id))} aria-label={`Select ${issue.identifier}`} />}
              <div className="min-w-0 flex-1 basis-48"><div className="flex flex-wrap items-center gap-2"><IssueLink issue={issue as CycleIssue} /><span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{issue.status}</span></div><p className="mt-1 text-xs text-muted-foreground">{issue.cycleId ? `Currently in ${source?.name ?? "another cycle"}` : "Backlog"} · {issue.assigneeId ? "Assigned" : "Unassigned"} · {issue.estimate === null ? "Unestimated" : `${issue.estimate} pts`}</p></div>
              <Button type="button" size="sm" variant="outline" disabled={saving || (Boolean(issue.cycleId) && !canMove)} onClick={() => void addPlannerIssue(issue)}>{issue.cycleId ? canMove ? "Move here" : "Completed cycle" : "Add to cycle"}</Button>
            </div>;
          }) : <div className="py-8 text-center"><p className="font-medium">No available issues</p><p className="mt-1 text-sm text-muted-foreground">Choose another project, or add issues to the backlog first.</p></div>}
        </AttioCard>
      </AttioSection>}

      <AttioSection title="Scope changes" description={cycle.status === "Active" ? "Every issue added or removed after the cycle started." : "Recorded additions and removals after this cycle started."}>
        <AttioCard padding={4}>
          {detail.scopeChanges.length ? <div className="divide-y">{[...detail.scopeChanges].reverse().map((change) => <div key={change.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="text-sm"><span className="font-medium">{change.action === "added" ? "Added" : "Removed"}</span> <span className="text-muted-foreground">by {change.actorName ?? "a teammate"}</span></p><p className="mt-1 text-sm"><IssueLink issue={change.issue} /></p></div><time className="shrink-0 text-xs text-muted-foreground" dateTime={change.createdAt}>{formatCycleTimestamp(change.createdAt)}</time></div>)}</div> : <p className="rounded-lg border border-dashed px-4 py-7 text-center text-sm text-muted-foreground">No scope changes have been recorded since this cycle started.</p>}
        </AttioCard>
      </AttioSection>
    </AttioStack>

    <Dialog open={Boolean(conflict && conflict.conflicting.length)} onOpenChange={(open) => { if (!open && conflict) void resolveCycleConflict(false); }}>
      <DialogContent><DialogHeader><DialogTitle>Someone else changed this</DialogTitle><DialogDescription>Compare the latest cycle values with yours, then keep your edits or take the latest values.</DialogDescription></DialogHeader>
        {conflict && <div className="grid max-h-72 gap-3 overflow-y-auto">{Object.entries(conflict.changes).map(([field, mine]) => <div key={field} className="grid gap-1 rounded-md border p-3 text-sm"><p className="font-medium">{field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}{conflict.conflicting.includes(field) ? " · changed by someone else" : " · safe to reapply"}</p><p><span className="text-muted-foreground">Your value: </span>{mine || "Empty"}</p><p><span className="text-muted-foreground">Latest value: </span>{String((conflict.current as unknown as Record<string, unknown>)[field] ?? "Empty")}</p></div>)}</div>}
        <DialogFooter><Button variant="outline" onClick={() => void resolveCycleConflict(false)}>Take the other values</Button><Button onClick={() => void resolveCycleConflict(true)}>Keep my changes</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={closeOpen} onOpenChange={(open) => { if (!saving) setCloseOpen(open); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Close {cycle.name}?</DialogTitle><DialogDescription>The cycle becomes read-only. Completed and unfinished issues are saved in its snapshot. Choose where unfinished issues should go.</DialogDescription></DialogHeader>
        <div className="grid gap-2"><Label htmlFor="cycle-unfinished-action">Unfinished issues</Label><Select value={unfinishedAction} disabled={saving} onValueChange={(value) => setUnfinishedAction(value as "carry" | "backlog")}><SelectTrigger id="cycle-unfinished-action"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="carry">Carry into the next upcoming cycle (create one if needed)</SelectItem><SelectItem value="backlog">Return to the backlog</SelectItem></SelectContent></Select></div>
        {actionError && <Alert variant="destructive"><AlertTitle>Could not close cycle</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setCloseOpen(false)}>Cancel</Button><Button type="button" disabled={saving} onClick={() => void closeCycle()}>{saving ? "Closing…" : "Close cycle"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </AttioPage>;
}
