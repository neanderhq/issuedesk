"use client";

import { ProjectUpdates } from "./project-updates";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, CalendarDays, LoaderCircle, Plus, RotateCw, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AttioButton } from "@/src/neander-design-pack/attio/2.0.0/AttioBlocks";
import { AttioEmpty } from "@/src/neander-design-pack/attio/2.0.0/AttioStates";
import { AttioCard, AttioGrid, AttioInline, AttioSection, AttioStack, AttioStat, AttioStats } from "@/src/neander-design-pack/attio/2.0.0/AttioLayouts";
import { ApiError, requestJson, type IssueMember } from "@/components/issues/issue-api";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { formatDate as formatDateOnly } from "@/lib/date-format";

type ProjectProgress = { totalIssues: number; doneIssues: number; totalPoints: number; donePoints: number };
type ProjectMilestone = {
  id: string;
  projectId: string;
  name: string;
  targetDate: string | null;
  position: number;
  version: number;
  progress: ProjectProgress;
};
type ProjectDetails = {
  id: string;
  name: string;
  description: string | null;
  leadUserId: string | null;
  startDate: string | null;
  targetDate: string | null;
  archivedAt: string | null;
  version: number;
  progress: ProjectProgress;
  milestones: ProjectMilestone[];
};
type ProjectDraft = { name: string; description: string; leadUserId: string; startDate: string; targetDate: string };
type MilestoneDraft = { name: string; targetDate: string };

function emptyProjectDraft(): ProjectDraft {
  return { name: "", description: "", leadUserId: "", startDate: "", targetDate: "" };
}

function progressText(progress: ProjectProgress) {
  return `${progress.doneIssues} of ${progress.totalIssues} issues done · ${progress.donePoints} of ${progress.totalPoints} points`;
}

function formatDate(value: string | null) {
  return value ? formatDateOnly(value) : "Not set";
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [members, setMembers] = useState<IssueMember[]>([]);
  const [draft, setDraft] = useState<ProjectDraft>(emptyProjectDraft);
  const [milestoneDraft, setMilestoneDraft] = useState<MilestoneDraft>({ name: "", targetDate: "" });
  const [milestoneDrafts, setMilestoneDrafts] = useState<Record<string, MilestoneDraft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const [milestoneToDelete, setMilestoneToDelete] = useState<ProjectMilestone | null>(null);
  const [conflict, setConflict] = useState<{ kind: "project" | "milestone"; id: string; current: ProjectDetails | ProjectMilestone; changes: Record<string, string | null>; conflicting: string[] } | null>(null);
  const draftsInitializedFor = useRef<string | null>(null);
  const projectDraftVersion = useRef<number | null>(null);
  const projectDraftActive = useRef(false);
  const projectDraftBase = useRef<Record<string, unknown> | null>(null);
  const milestoneDraftVersions = useRef<Record<string, number>>({});
  const milestoneDraftBases = useRef<Record<string, Record<string, unknown>>>({});

  const load = useCallback(async () => {
    setError("");
    try {
      const [projectResponse, memberResponse] = await Promise.all([
        requestJson<ProjectDetails>(`/api/projects/${encodeURIComponent(projectId)}`),
        requestJson<{ members: IssueMember[] }>("/api/members"),
      ]);
      if (!projectDraftActive.current) {
        projectDraftVersion.current = projectResponse.version;
        projectDraftBase.current = { name: projectResponse.name, description: projectResponse.description, leadUserId: projectResponse.leadUserId, startDate: projectResponse.startDate, targetDate: projectResponse.targetDate };
      }
      setProject({
        ...projectResponse,
        version: projectDraftActive.current ? projectDraftVersion.current ?? projectResponse.version : projectResponse.version,
        milestones: projectResponse.milestones.map((milestone) => ({
          ...milestone,
          version: milestoneDraftVersions.current[milestone.id] ?? milestone.version,
        })),
      });
      if (draftsInitializedFor.current !== projectId) {
        setDraft({
          name: projectResponse.name,
          description: projectResponse.description ?? "",
          leadUserId: projectResponse.leadUserId ?? "",
          startDate: projectResponse.startDate ?? "",
          targetDate: projectResponse.targetDate ?? "",
        });
        draftsInitializedFor.current = projectId;
      }
      setMembers(memberResponse.members);
      setMilestoneDrafts((current) => {
        const next = { ...current };
        for (const milestone of projectResponse.milestones) {
          if (!Object.prototype.hasOwnProperty.call(next, milestone.id)) {
            next[milestone.id] = { name: milestone.name, targetDate: milestone.targetDate ?? "" };
          }
          if (milestoneDraftVersions.current[milestone.id] === undefined) milestoneDraftBases.current[milestone.id] = { name: milestone.name, targetDate: milestone.targetDate };
        }
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This project could not be loaded.");
      setProject(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useLiveUpdates(load);

  useEffect(() => { void load(); }, [load]);

  const activeMembers = useMemo(() => members.filter((member) => member.active), [members]);
  const memberName = members.find((member) => member.id === project?.leadUserId)?.name ?? (project?.leadUserId ? "Former member" : "No lead assigned");

  function markProjectDraft() {
    if (!projectDraftActive.current) {
      projectDraftVersion.current = project?.version ?? null;
      projectDraftBase.current = project ? { name: project.name, description: project.description, leadUserId: project.leadUserId, startDate: project.startDate, targetDate: project.targetDate } : null;
      projectDraftActive.current = true;
    }
  }

  function markMilestoneDraft(milestoneId: string) {
    if (milestoneDraftVersions.current[milestoneId] !== undefined) return;
    const milestone = project?.milestones.find((item) => item.id === milestoneId);
    if (milestone) {
      milestoneDraftVersions.current[milestoneId] = milestone.version;
      milestoneDraftBases.current[milestoneId] = { name: milestone.name, targetDate: milestone.targetDate };
    }
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const fields: Record<string, string | null> = {};
    if (draft.name.trim() !== project.name) fields.name = draft.name.trim();
    if (draft.description.trim() !== (project.description ?? "")) fields.description = draft.description.trim() || null;
    if ((draft.leadUserId || null) !== project.leadUserId) fields.leadUserId = draft.leadUserId || null;
    if ((draft.startDate || null) !== project.startDate) fields.startDate = draft.startDate || null;
    if ((draft.targetDate || null) !== project.targetDate) fields.targetDate = draft.targetDate || null;
    if (!Object.keys(fields).length) return;
    setSaving(true);
    setError("");
    try {
      await requestJson<ProjectDetails>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, version: projectDraftVersion.current ?? project.version }),
      });
      projectDraftActive.current = false;
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.current && typeof cause.current === "object") {
        const current = cause.current as ProjectDetails;
        const base = projectDraftBase.current ?? project as unknown as Record<string, unknown>;
        const conflicting = Object.keys(fields).filter((key) => !Object.is((current as unknown as Record<string, unknown>)[key], base[key]));
        setProject(current);
        setDraft({ name: draft.name, description: draft.description, leadUserId: draft.leadUserId, startDate: draft.startDate, targetDate: draft.targetDate });
        if (!conflicting.length) {
          void requestJson<ProjectDetails>(`/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, version: current.version }) }).then(() => { projectDraftActive.current = false; projectDraftBase.current = null; void load(); }).catch((retryError) => setError(retryError instanceof Error ? retryError.message : "The project could not be saved."));
        } else setConflict({ kind: "project", id: project.id, current, changes: fields, conflicting });
        setError("");
      } else setError(cause instanceof Error ? cause.message : "The project could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    if (!project) return;
    setSaving(true);
    setError("");
    try {
      await requestJson<ProjectDetails>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived, version: project.version }),
      });
      setArchiveConfirmationOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? "Someone else changed this project. Refresh to review the latest version." : cause instanceof Error ? cause.message : "The project could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  async function addMilestone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !milestoneDraft.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await requestJson<ProjectMilestone>("/api/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, name: milestoneDraft.name.trim(), targetDate: milestoneDraft.targetDate || null }),
      });
      setMilestoneDraft({ name: "", targetDate: "" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The milestone could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function saveMilestone(milestone: ProjectMilestone) {
    const next = milestoneDrafts[milestone.id] ?? { name: milestone.name, targetDate: milestone.targetDate ?? "" };
    const fields: Record<string, string | null> = {};
    if (next.name.trim() !== milestone.name) fields.name = next.name.trim();
    if ((next.targetDate || null) !== milestone.targetDate) fields.targetDate = next.targetDate || null;
    if (!Object.keys(fields).length) return;
    setSaving(true);
    setError("");
    try {
      await requestJson<ProjectMilestone>(`/api/milestones/${encodeURIComponent(milestone.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, version: milestone.version }),
      });
      delete milestoneDraftVersions.current[milestone.id];
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.current && typeof cause.current === "object") {
        const current = cause.current as ProjectMilestone;
        const base = milestoneDraftBases.current[milestone.id] ?? milestone as unknown as Record<string, unknown>;
        const conflicting = Object.keys(fields).filter((key) => !Object.is((current as unknown as Record<string, unknown>)[key], base[key]));
        if (!conflicting.length) {
          void requestJson<ProjectMilestone>(`/api/milestones/${encodeURIComponent(milestone.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, version: current.version }) }).then(() => { delete milestoneDraftVersions.current[milestone.id]; delete milestoneDraftBases.current[milestone.id]; void load(); }).catch((retryError) => setError(retryError instanceof Error ? retryError.message : "The milestone could not be saved."));
        } else setConflict({ kind: "milestone", id: milestone.id, current, changes: fields, conflicting });
        setError("");
      } else setError(cause instanceof Error ? cause.message : "The milestone could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function resolveConflict(keepMine: boolean) {
    if (!conflict) return;
    const pending = conflict; setConflict(null);
    const changes = Object.fromEntries(Object.entries(pending.changes).filter(([field]) => !pending.conflicting.includes(field) || keepMine));
    if (pending.kind === "project") {
      const current = pending.current as ProjectDetails;
      if (!Object.keys(changes).length) { projectDraftActive.current = false; projectDraftBase.current = null; await load(); return; }
      setSaving(true);
      try {
        await requestJson<ProjectDetails>(`/api/projects/${encodeURIComponent(pending.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...changes, version: current.version }) });
        projectDraftActive.current = false; projectDraftBase.current = null; await load();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "The project could not be saved."); }
      finally { setSaving(false); }
    } else {
      const current = pending.current as ProjectMilestone;
      if (!Object.keys(changes).length) { delete milestoneDraftVersions.current[pending.id]; delete milestoneDraftBases.current[pending.id]; await load(); return; }
      setSaving(true);
      try {
        await requestJson<ProjectMilestone>(`/api/milestones/${encodeURIComponent(pending.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...changes, version: current.version }) });
        delete milestoneDraftVersions.current[pending.id]; delete milestoneDraftBases.current[pending.id]; await load();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "The milestone could not be saved."); }
      finally { setSaving(false); }
    }
  }

  async function deleteMilestone() {
    if (!milestoneToDelete) return;
    setSaving(true);
    setError("");
    try {
      await requestJson<{ deleted: boolean }>(`/api/milestones/${encodeURIComponent(milestoneToDelete.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: milestoneToDelete.version }),
      });
      setMilestoneToDelete(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? "Someone else changed this milestone. Refresh to review the latest version." : cause instanceof Error ? cause.message : "The milestone could not be deleted.");
    } finally {
      setSaving(false);
    }
  }

  async function reorderMilestones(index: number, direction: -1 | 1) {
    if (!project) return;
    const next = [...project.milestones];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= next.length) return;
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setSaving(true);
    setError("");
    try {
      const response = await requestJson<{ milestones: ProjectMilestone[] }>("/api/milestones/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, milestones: next.map(({ id, version }) => ({ id, version })) }),
      });
      const progressById = new Map(project.milestones.map((milestone) => [milestone.id, milestone.progress]));
      const reordered = response.milestones.map((milestone) => ({ ...milestone, progress: progressById.get(milestone.id) ?? { totalIssues: 0, doneIssues: 0, totalPoints: 0, donePoints: 0 } }));
      setProject({ ...project, milestones: reordered });
      setMilestoneDrafts(Object.fromEntries(reordered.map((milestone) => [milestone.id, { name: milestone.name, targetDate: milestone.targetDate ?? "" }])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The milestone order could not be saved.");
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <AttioEmpty title="Loading project" description="Project details are on their way." />;
  if (!project) return <AttioStack>
    <AttioSection title="Project unavailable" actions={<Button asChild variant="outline"><Link href="/projects"><ArrowLeft />Back to projects</Link></Button>}><div /></AttioSection>
    <Alert variant="destructive"><AlertTitle>Could not open this project</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{error || "This project could not be found."}<Button size="xs" variant="outline" onClick={() => void load()}><RotateCw />Try again</Button></AlertDescription></Alert>
  </AttioStack>;

  const archived = Boolean(project.archivedAt);
  return <AttioStack>
      <AttioSection title={project.name} description={project.description || "No description yet."} actions={<div className="flex min-w-0 flex-wrap gap-2"><Button asChild variant="outline" size="sm"><Link href="/projects"><ArrowLeft />Projects</Link></Button>{archived ? <Button size="sm" disabled={saving} onClick={() => void setArchived(false)}><ArchiveRestore />Restore</Button> : <Button size="sm" variant="outline" disabled={saving} onClick={() => setArchiveConfirmationOpen(true)}><Archive />Archive project</Button>}</div>}><div /></AttioSection>
      {error && <Alert variant="destructive"><AlertTitle>Project update needs attention</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{error}<Button size="xs" variant="outline" onClick={() => void load()}><RotateCw />Refresh</Button></AlertDescription></Alert>}
      {archived && <Alert><Archive /><AlertTitle>Archived project</AlertTitle><AlertDescription>It no longer appears in issue pickers. Existing issues keep their project name.</AlertDescription></Alert>}
      <AttioStats>
        <AttioStat label="Issues done" value={`${project.progress.doneIssues} / ${project.progress.totalIssues}`} detail="Non-archived issues" />
        <AttioStat label="Estimate points done" value={`${project.progress.donePoints} / ${project.progress.totalPoints}`} detail="Unestimated issues count as zero points" />
        <AttioStat label="Project lead" value={memberName} detail={`${formatDate(project.startDate)} – ${formatDate(project.targetDate)}`} />
      </AttioStats>
      <ProjectUpdates projectId={projectId} archived={archived} />
      <AttioGrid columns={2} min={300}>
        <AttioCard><form onSubmit={(event) => void saveProject(event)} className="grid min-w-0 gap-4">
          <AttioSection title="Project details" description="Update the project name, description, lead, and dates."><div /></AttioSection>
          <div className="grid min-w-0 gap-2"><Label htmlFor="edit-project-name">Name</Label><Input id="edit-project-name" value={draft.name} maxLength={120} disabled={archived || saving} onChange={(event) => { markProjectDraft(); setDraft({ ...draft, name: event.target.value }); }} required /></div>
          <div className="grid min-w-0 gap-2"><Label htmlFor="edit-project-description">Description</Label><Textarea id="edit-project-description" value={draft.description} maxLength={20000} rows={6} disabled={archived || saving} onChange={(event) => { markProjectDraft(); setDraft({ ...draft, description: event.target.value }); }} className="break-words [overflow-wrap:anywhere]" /></div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-2 sm:col-span-2"><Label htmlFor="edit-project-lead">Project lead</Label><Select value={draft.leadUserId || "none"} disabled={archived || saving} onValueChange={(leadUserId) => { markProjectDraft(); setDraft({ ...draft, leadUserId: leadUserId === "none" ? "" : leadUserId }); }}><SelectTrigger id="edit-project-lead" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No lead</SelectItem>{activeMembers.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid min-w-0 gap-2"><Label htmlFor="edit-project-start">Start date</Label><Input id="edit-project-start" type="date" value={draft.startDate} disabled={archived || saving} onChange={(event) => { markProjectDraft(); setDraft({ ...draft, startDate: event.target.value }); }} /></div>
            <div className="grid min-w-0 gap-2"><Label htmlFor="edit-project-target">Target date</Label><Input id="edit-project-target" type="date" value={draft.targetDate} disabled={archived || saving} onChange={(event) => { markProjectDraft(); setDraft({ ...draft, targetDate: event.target.value }); }} /></div>
          </div>
          {!archived && <AttioInline justify="end"><AttioButton type="submit" disabled={saving || !draft.name.trim()} leadingIcon={saving ? undefined : "check"}>{saving ? <><LoaderCircle className="animate-spin" />Saving…</> : "Save changes"}</AttioButton></AttioInline>}
        </form></AttioCard>
        <AttioCard><AttioStack>
          <AttioSection title="Milestones" description="Set target dates, track issue progress, and adjust the order."><div /></AttioSection>
          {project.milestones.length ? <ol className="grid min-w-0 gap-3">
            {project.milestones.map((milestone, index) => {
              const milestoneDraft = milestoneDrafts[milestone.id] ?? { name: milestone.name, targetDate: milestone.targetDate ?? "" };
              return <li key={milestone.id} className="grid min-w-0 gap-3 rounded-lg border bg-background p-3">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0 flex-1"><Label htmlFor={`milestone-name-${milestone.id}`}>Milestone {index + 1}</Label><Input id={`milestone-name-${milestone.id}`} value={milestoneDraft.name} maxLength={120} disabled={archived || saving} onChange={(event) => { markMilestoneDraft(milestone.id); setMilestoneDrafts({ ...milestoneDrafts, [milestone.id]: { ...milestoneDraft, name: event.target.value } }); }} className="mt-1" /></div>
                  <div className="flex shrink-0 gap-1 pt-6"><Button type="button" size="icon" variant="outline" aria-label={`Move ${milestone.name} earlier`} disabled={archived || saving || index === 0} onClick={() => void reorderMilestones(index, -1)}><ArrowUp /></Button><Button type="button" size="icon" variant="outline" aria-label={`Move ${milestone.name} later`} disabled={archived || saving || index === project.milestones.length - 1} onClick={() => void reorderMilestones(index, 1)}><ArrowDown /></Button></div>
                </div>
                <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="grid min-w-0 gap-2"><Label htmlFor={`milestone-date-${milestone.id}`}>Target date</Label><Input id={`milestone-date-${milestone.id}`} type="date" value={milestoneDraft.targetDate} disabled={archived || saving} onChange={(event) => { markMilestoneDraft(milestone.id); setMilestoneDrafts({ ...milestoneDrafts, [milestone.id]: { ...milestoneDraft, targetDate: event.target.value } }); }} /></div>
                  <div className="flex min-w-0 flex-col justify-end gap-1 text-xs text-muted-foreground"><span>{milestone.progress.doneIssues} / {milestone.progress.totalIssues} issues done</span><span>{milestone.progress.donePoints} / {milestone.progress.totalPoints} estimate points done</span></div>
                </div>
                {!archived && <AttioInline justify="between"><span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><CalendarDays className="size-3.5 shrink-0" />Target: {formatDate(milestone.targetDate)}</span><div className="flex gap-2"><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setMilestoneToDelete(milestone)}><Trash2 />Delete</Button><Button type="button" size="sm" variant="outline" disabled={saving || !milestoneDraft.name.trim()} onClick={() => void saveMilestone(milestone)}>Save</Button></div></AttioInline>}
              </li>;
            })}
          </ol> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No milestones yet. Add one below to break the project into stages.</p>}
          {!archived && <form onSubmit={(event) => void addMilestone(event)} className="grid min-w-0 gap-3 rounded-lg border border-dashed p-3">
            <div className="grid min-w-0 gap-2"><Label htmlFor="new-milestone-name">New milestone</Label><Input id="new-milestone-name" value={milestoneDraft.name} maxLength={120} disabled={saving} onChange={(event) => setMilestoneDraft({ ...milestoneDraft, name: event.target.value })} placeholder="Milestone name" required /></div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"><div className="grid min-w-0 gap-2"><Label htmlFor="new-milestone-date">Target date</Label><Input id="new-milestone-date" type="date" value={milestoneDraft.targetDate} disabled={saving} onChange={(event) => setMilestoneDraft({ ...milestoneDraft, targetDate: event.target.value })} /></div><Button type="submit" className="w-full self-end sm:w-auto" disabled={saving || !milestoneDraft.name.trim()}><Plus />Add milestone</Button></div>
          </form>}
        </AttioStack></AttioCard>
      </AttioGrid>
    <Dialog open={Boolean(conflict && conflict.conflicting.length)} onOpenChange={(open) => { if (!open && conflict) void resolveConflict(false); }}>
      <DialogContent><DialogHeader><DialogTitle>Someone else changed this</DialogTitle><DialogDescription>Review both values. You can keep your edits or take the latest values.</DialogDescription></DialogHeader>
        {conflict && <div className="grid max-h-72 gap-3 overflow-y-auto">{conflict.changes && Object.entries(conflict.changes).map(([field, mine]) => <div key={field} className="grid gap-1 rounded-md border p-3 text-sm"><p className="font-medium">{field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}{conflict.conflicting.includes(field) ? " · changed by someone else" : " · safe to reapply"}</p><p><span className="text-muted-foreground">Your value: </span>{mine ?? "Empty"}</p><p><span className="text-muted-foreground">Latest value: </span>{String((conflict.current as unknown as Record<string, unknown>)[field] ?? "Empty")}</p></div>)}</div>}
        <DialogFooter><Button variant="outline" onClick={() => void resolveConflict(false)}>Take the other values</Button><Button onClick={() => void resolveConflict(true)}>Keep my changes</Button></DialogFooter>
      </DialogContent>
    </Dialog>
        <AlertDialog open={archiveConfirmationOpen} onOpenChange={(open) => { if (!saving) setArchiveConfirmationOpen(open); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive this project?</AlertDialogTitle><AlertDialogDescription>It will disappear from issue pickers. Issues already assigned to it will keep showing the project name.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void setArchived(true); }}>Archive project</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={Boolean(milestoneToDelete)} onOpenChange={(open) => { if (!open && !saving) setMilestoneToDelete(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this milestone?</AlertDialogTitle><AlertDialogDescription>Issues assigned to it will remain in the project, with no milestone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void deleteMilestone(); }}>Delete milestone</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </AttioStack>;
}
