"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArchiveRestore, Plus, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AttioCollectionToolbar, AttioDataTable, type AttioColumn } from "@/src/neander-design-pack/attio/2.0.0/AttioCrmBlocks";
import { AttioButton, AttioModal } from "@/src/neander-design-pack/attio/2.0.0/AttioBlocks";
import { AttioEmpty } from "@/src/neander-design-pack/attio/2.0.0/AttioStates";
import { AttioStack } from "@/src/neander-design-pack/attio/2.0.0/AttioLayouts";
import { requestJson, type IssueMember } from "@/components/issues/issue-api";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { formatDate as formatDateOnly } from "@/lib/date-format";

type ProjectProgress = { totalIssues: number; doneIssues: number; totalPoints: number; donePoints: number };
type ProjectRecord = {
  id: string;
  name: string;
  description: string | null;
  leadUserId: string | null;
  startDate: string | null;
  targetDate: string | null;
  archivedAt: string | null;
  version: number;
  progress: ProjectProgress;
};
type ProjectRow = { id: string; name: string; lead: string; dates: string; progress: string; archivedAt: string | null };

function formatDate(value: string | null) {
  return value ? formatDateOnly(value) : "—";
}

export function ProjectsListPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [members, setMembers] = useState<IssueMember[]>([]);
  const [view, setView] = useState("Active projects");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [projectResponse, memberResponse] = await Promise.all([
        requestJson<{ projects: ProjectRecord[] }>("/api/projects"),
        requestJson<{ members: IssueMember[] }>("/api/members"),
      ]);
      setProjects(projectResponse.projects);
      setMembers(memberResponse.members);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Projects could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useLiveUpdates(load);

  useEffect(() => { void load(); }, [load]);

  const visibleProjects = useMemo(() => projects.filter((project) => {
    const matchesView = view === "Archived projects" ? Boolean(project.archivedAt) : !project.archivedAt;
    return matchesView && `${project.name} ${project.description ?? ""}`.toLowerCase().includes(query.toLowerCase());
  }), [projects, query, view]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);
  const rows: ProjectRow[] = visibleProjects.map((project) => ({
    id: project.id,
    name: project.name,
    lead: project.leadUserId ? memberById.get(project.leadUserId) ?? "Former member" : "Unassigned",
    dates: `${formatDate(project.startDate)} – ${formatDate(project.targetDate)}`,
    progress: `${project.progress.doneIssues} / ${project.progress.totalIssues} issues · ${project.progress.donePoints} / ${project.progress.totalPoints} pts`,
    archivedAt: project.archivedAt,
  }));

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const selectedLead = String(form.get("leadUserId") ?? "");
    const leadUserId = selectedLead === "none" ? "" : selectedLead;
    const startDate = String(form.get("startDate") ?? "");
    const targetDate = String(form.get("targetDate") ?? "");
    setFormError("");
    setPending(true);
    try {
      await requestJson<ProjectRecord>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          leadUserId: leadUserId || null,
          startDate: startDate || null,
          targetDate: targetDate || null,
        }),
      });
      setCreateOpen(false);
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The project could not be created.");
    } finally {
      setPending(false);
    }
  }

  async function restoreProject(projectId: string) {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    setPending(true);
    try {
      await requestJson<ProjectRecord>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false, version: project.version }),
      });
      await load();
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "The project could not be restored.");
    } finally {
      setPending(false);
    }
  }

  const columns: AttioColumn<ProjectRow>[] = [
    { key: "name", label: "Project", sortable: true, render: (_value, row) => <Link className="font-medium text-primary underline-offset-4 hover:underline" href={`/projects/${encodeURIComponent(row.id)}`}>{row.name}</Link> },
    { key: "lead", label: "Lead", sortable: true },
    { key: "dates", label: "Start · target", sortable: true },
    { key: "progress", label: "Progress" },
    ...(view === "Archived projects" ? [{
      key: "archivedAt" as const,
      label: "Actions",
      render: (_value: string | null, row: ProjectRow) => <Button size="sm" variant="outline" disabled={pending} onClick={() => void restoreProject(row.id)}><ArchiveRestore />Restore</Button>,
    }] : []),
  ];

  return <AttioStack>
      <AttioCollectionToolbar
        view={view}
        views={["Active projects", "Archived projects"]}
        onViewChange={setView}
        secondaryAction={<Input aria-label="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="w-28 sm:w-52" />}
        primaryAction={<AttioButton leadingIcon="plus" onClick={() => { setFormError(""); setCreateOpen(true); }}>New project</AttioButton>}
      />
      {loadError && <Alert variant="destructive"><AlertTitle>Projects need attention</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{loadError}<Button size="xs" variant="outline" onClick={() => void load()}><RotateCw />Try again</Button></AlertDescription></Alert>}
      {loading ? <AttioEmpty title="Loading projects" description="Your project list is on its way." /> : visibleProjects.length ? <AttioDataTable columns={columns} rows={rows} selectable={false} /> : <AttioEmpty title={query ? "No matching projects" : view === "Archived projects" ? "No archived projects" : "No projects yet"} description={query ? "Try a different search." : view === "Archived projects" ? "Archived projects will appear here." : "Create a project to organize issues and milestones."} action={view === "Active projects" && <Button onClick={() => setCreateOpen(true)}><Plus />Create project</Button>} />}
    <AttioModal open={createOpen} onClose={() => { if (!pending) setCreateOpen(false); }} title="Create project" size="wide" footer={<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" form="create-project-form" disabled={pending}>{pending ? "Creating…" : "Create project"}</Button></div>}>
      <form id="create-project-form" onSubmit={(event) => void createProject(event)} className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-2"><Label htmlFor="project-name">Name</Label><Input id="project-name" name="name" required maxLength={120} autoFocus /></div>
        <div className="grid min-w-0 gap-2"><Label htmlFor="project-description">Description</Label><Textarea id="project-description" name="description" maxLength={20000} rows={5} className="break-words [overflow-wrap:anywhere]" /></div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="grid min-w-0 gap-2"><Label htmlFor="project-lead">Project lead</Label><Select name="leadUserId" defaultValue="none"><SelectTrigger id="project-lead" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No lead</SelectItem>{members.filter((member) => member.active).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="grid min-w-0 gap-2"><Label htmlFor="project-start-date">Start date</Label><Input id="project-start-date" name="startDate" type="date" /></div>
          <div className="grid min-w-0 gap-2"><Label htmlFor="project-target-date">Target date</Label><Input id="project-target-date" name="targetDate" type="date" /></div>
        </div>
        {formError && <p className="break-words text-sm text-destructive" role="alert">{formError}</p>}
      </form>
    </AttioModal>
  </AttioStack>;
}
