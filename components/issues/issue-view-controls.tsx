"use client";

import { useEffect, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, issuePriorities, issueStatuses, requestJson, type IssueLabelOption, type IssueMember, type IssueProject } from "./issue-api";
import { hasIssueFilters, type IssueFilters } from "./issue-filters";

type IssueCycle = { id: string; name: string; status: string };
export type SavedViewRecord = { id: string; workspaceId: string; ownerId: string | null; name: string; filters: Record<string, unknown>; layout: "List" | "Board"; shared: boolean; version: number };

type ControlsProps = {
  filters: IssueFilters;
  onFiltersChange: (filters: IssueFilters) => void;
  layout: "List" | "Board";
  savedView?: SavedViewRecord;
  canManageSavedView?: boolean;
  onSavedViewChange?: (view: SavedViewRecord | null) => void;
};

function FilterFields({ filters, onFiltersChange, metadata, suffix }: {
  filters: IssueFilters;
  onFiltersChange: (filters: IssueFilters) => void;
  metadata: { projects: IssueProject[]; members: IssueMember[]; labels: IssueLabelOption[]; cycles: IssueCycle[] };
  suffix: string;
}) {
  function change(key: keyof IssueFilters, value: string) {
    onFiltersChange({ ...filters, [key]: value === "all" ? undefined : value });
  }

  return <>
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`issue-project-filter-${suffix}`}>Project</Label>
      <Select value={filters.projectId ?? "all"} onValueChange={(value) => change("projectId", value)}>
        <SelectTrigger id={`issue-project-filter-${suffix}`} className="w-full min-w-0"><SelectValue placeholder="All projects" /></SelectTrigger>
        <SelectContent><SelectItem value="all">All projects</SelectItem><SelectItem value="none">No project</SelectItem>{metadata.projects.filter((project) => !project.archivedAt).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`issue-status-filter-${suffix}`}>Status</Label>
      <Select value={filters.status ?? "all"} onValueChange={(value) => change("status", value)}>
        <SelectTrigger id={`issue-status-filter-${suffix}`} className="w-full min-w-0"><SelectValue placeholder="All statuses" /></SelectTrigger>
        <SelectContent><SelectItem value="all">All statuses</SelectItem>{issueStatuses.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`issue-priority-filter-${suffix}`}>Priority</Label>
      <Select value={filters.priority ?? "all"} onValueChange={(value) => change("priority", value)}>
        <SelectTrigger id={`issue-priority-filter-${suffix}`} className="w-full min-w-0"><SelectValue placeholder="All priorities" /></SelectTrigger>
        <SelectContent><SelectItem value="all">All priorities</SelectItem>{issuePriorities.map((priority) => <SelectItem key={priority} value={priority}>{priority}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`issue-assignee-filter-${suffix}`}>Assignee</Label>
      <Select value={filters.assigneeId ?? "all"} onValueChange={(value) => change("assigneeId", value)}>
        <SelectTrigger id={`issue-assignee-filter-${suffix}`} className="w-full min-w-0"><SelectValue placeholder="Anyone" /></SelectTrigger>
        <SelectContent><SelectItem value="all">Anyone</SelectItem><SelectItem value="none">Unassigned</SelectItem>{metadata.members.filter((member) => member.active).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`issue-label-filter-${suffix}`}>Label</Label>
      <Select value={filters.labelId ?? "all"} onValueChange={(value) => change("labelId", value)}>
        <SelectTrigger id={`issue-label-filter-${suffix}`} className="w-full min-w-0"><SelectValue placeholder="Any label" /></SelectTrigger>
        <SelectContent><SelectItem value="all">Any label</SelectItem>{metadata.labels.map((label) => <SelectItem key={label.id} value={label.id}>{label.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`issue-cycle-filter-${suffix}`}>Cycle</Label>
      <Select value={filters.cycleId ?? "all"} onValueChange={(value) => change("cycleId", value)}>
        <SelectTrigger id={`issue-cycle-filter-${suffix}`} className="w-full min-w-0"><SelectValue placeholder="Any cycle" /></SelectTrigger>
        <SelectContent><SelectItem value="all">Any cycle</SelectItem><SelectItem value="none">No cycle</SelectItem>{metadata.cycles.map((cycle) => <SelectItem key={cycle.id} value={cycle.id}>{cycle.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  </>;
}

export function IssueViewControls({ filters, onFiltersChange, layout, savedView, canManageSavedView = false, onSavedViewChange }: ControlsProps) {
  const managedView = canManageSavedView ? savedView : undefined;
  const [metadata, setMetadata] = useState<{ projects: IssueProject[]; members: IssueMember[]; labels: IssueLabelOption[]; cycles: IssueCycle[] }>({ projects: [], members: [], labels: [], cycles: [] });
  const [metadataError, setMetadataError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [viewLayout, setViewLayout] = useState<"List" | "Board">(layout);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      requestJson<{ projects: IssueProject[] }>("/api/projects"),
      requestJson<{ members: IssueMember[] }>("/api/members"),
      requestJson<{ labels: IssueLabelOption[] }>("/api/labels"),
      requestJson<{ cycles: IssueCycle[] }>("/api/cycles"),
    ]).then(([projects, members, labels, cycles]) => setMetadata({ projects: projects.projects, members: members.members, labels: labels.labels, cycles: cycles.cycles }))
      .catch(() => setMetadataError("Filter options could not be loaded. Refresh to try again."));
  }, []);

  async function saveNewView() {
    setPending(true);
    setError("");
    try {
      const created = await requestJson<SavedViewRecord>("/api/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, filters, layout: viewLayout, shared }),
      });
      window.dispatchEvent(new CustomEvent("saved-views-changed"));
      setSaveOpen(false);
      window.location.assign(`/saved-views/${created.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The saved view could not be created.");
    } finally {
      setPending(false);
    }
  }

  async function updateView(changes: Partial<Pick<SavedViewRecord, "name" | "filters" | "layout" | "shared">>) {
    if (!managedView) return;
    setPending(true);
    setError("");
    try {
      const updated = await requestJson<SavedViewRecord>(`/api/saved-views/${encodeURIComponent(managedView.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...changes, version: managedView.version }),
      });
      onSavedViewChange?.(updated);
      window.dispatchEvent(new CustomEvent("saved-views-changed"));
      setSaveOpen(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The saved view could not be updated.");
    } finally {
      setPending(false);
    }
  }

  async function deleteView() {
    if (!managedView) return;
    setPending(true);
    setError("");
    try {
      await requestJson(`/api/saved-views/${encodeURIComponent(managedView.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: managedView.version }),
      });
      onSavedViewChange?.(null);
      window.dispatchEvent(new CustomEvent("saved-views-changed"));
      window.location.assign("/list");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The saved view could not be deleted.");
    } finally {
      setPending(false);
    }
  }

  function clearFilters() {
    onFiltersChange({});
    setFiltersOpen(false);
  }

  return <div className="mb-4 min-w-0 space-y-2 rounded-lg border bg-card p-3">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-44">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input aria-label="Search issues" placeholder="Search issues…" maxLength={200} value={filters.q ?? ""} onChange={(event) => onFiltersChange({ ...filters, q: event.target.value || undefined })} className="min-w-0 pl-9" />
      </div>
      <Button type="button" variant="outline" className="sm:hidden" onClick={() => setFiltersOpen(true)}><SlidersHorizontal />Filters{hasIssueFilters(filters) && <span className="ml-1 size-2 rounded-full bg-primary" aria-label="Filters active" />}</Button>
      <Button type="button" variant={managedView ? "outline" : "default"} onClick={() => { setName(managedView?.name ?? (savedView ? `${savedView.name} copy` : "")); setShared(managedView?.shared ?? false); setViewLayout(managedView?.layout ?? layout); setError(""); setSaveOpen(true); }}>{managedView ? "Manage view" : "Save view"}</Button>
      {hasIssueFilters(filters) && <Button type="button" variant="ghost" onClick={clearFilters}>Clear filters</Button>}
    </div>
    <div className="hidden min-w-0 grid-cols-2 gap-2 sm:grid sm:grid-cols-3 lg:grid-cols-6">
      <FilterFields filters={filters} onFiltersChange={onFiltersChange} metadata={metadata} suffix="desktop" />
    </div>
    {metadataError && <p className="text-xs text-destructive" role="status">{metadataError}</p>}

    <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
      <DialogContent className="fixed !top-auto !bottom-2 left-1/2 w-[calc(100vw-1rem)] max-w-md !translate-y-0 sm:hidden">
        <DialogHeader><DialogTitle>Filter issues</DialogTitle><DialogDescription>Combine filters to narrow the issues shown.</DialogDescription></DialogHeader>
        <div className="grid min-w-0 grid-cols-2 gap-3 py-2"><FilterFields filters={filters} onFiltersChange={onFiltersChange} metadata={metadata} suffix="mobile" /></div>
        <DialogFooter className="flex-row justify-between"><Button variant="ghost" onClick={clearFilters}>Clear filters</Button><Button onClick={() => setFiltersOpen(false)}>Show issues</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
        <DialogHeader><DialogTitle>{managedView ? "Manage saved view" : "Save this view"}</DialogTitle><DialogDescription>Keep these filters and your chosen layout for quick access.</DialogDescription></DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="saved-view-name">Name</Label><Input id="saved-view-name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="For example, Launch blockers" /></div>
          <div className="grid gap-2"><Label htmlFor="saved-view-privacy">Privacy</Label><Select value={shared ? "shared" : "private"} onValueChange={(value) => setShared(value === "shared")}><SelectTrigger id="saved-view-privacy" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="private">Private to me</SelectItem><SelectItem value="shared">Shared with workspace</SelectItem></SelectContent></Select></div>
          <div className="grid gap-2"><Label htmlFor="saved-view-layout">Layout</Label><Select value={viewLayout} onValueChange={(value) => setViewLayout(value as "List" | "Board")}><SelectTrigger id="saved-view-layout" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="List">List</SelectItem><SelectItem value="Board">Board</SelectItem></SelectContent></Select></div>
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter className="flex-wrap sm:justify-between">
          {managedView ? <>
            <Button type="button" variant="destructive" disabled={pending} onClick={() => { if (window.confirm(`Delete “${managedView.name}”?`)) void deleteView(); }}>Delete view</Button>
            <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={pending || !name.trim()} onClick={() => void updateView({ name })}>Rename</Button><Button type="button" disabled={pending || !name.trim()} onClick={() => void updateView({ name, shared, filters, layout: viewLayout })}>Update view</Button></div>
          </> : <Button type="button" disabled={pending || !name.trim()} onClick={() => void saveNewView()}>Save view</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
