"use client";

import { useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { bulkUpdateIssues, issuePriorities, issueStatuses, requestJson, type BulkIssueAction, type IssueCycleOption, type IssueLabelOption, type IssueMember, type IssueMilestone, type IssuePriority, type IssueProject, type IssueRecord, type IssueStatus } from "./issue-api";

type BulkIssueActionType = BulkIssueAction["type"];
type IssueActionType = BulkIssueActionType | "cycle";

type IssueBulkActionsProps = {
  visibleIssues: IssueRecord[];
  selectedIssues: Array<Pick<IssueRecord, "id" | "version">>;
  members: IssueMember[];
  projects: IssueProject[];
  milestones?: IssueMilestone[];
  labels: IssueLabelOption[];
  cycles?: IssueCycleOption[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onUpdated: (issues: IssueRecord[]) => void;
  onCycleChange?: () => void;
  onClearSelection: () => void;
  archivedMode?: boolean;
};

export function IssueBulkActions({ visibleIssues, selectedIssues, members, projects, milestones = [], labels, cycles = [], busy, onBusyChange, onSelectAll, onUpdated, onCycleChange, onClearSelection, archivedMode = false }: IssueBulkActionsProps) {
  const [actionType, setActionType] = useState<IssueActionType>(archivedMode ? "restore" : "status");
  const [targetValue, setTargetValue] = useState("");
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const selectedCount = selectedIssues.length;
  const allSelected = visibleIssues.length > 0 && visibleIssues.every((issue) => selectedIssues.some((selected) => selected.id === issue.id));
  const someSelected = !allSelected && selectedCount > 0;
  const targetRequired = actionType !== "archive" && actionType !== "restore";

  function createAction(): BulkIssueAction | null {
    if (actionType === "cycle") return null;
    if (actionType === "archive") return { type: "archive" };
    if (actionType === "restore") return { type: "restore" };
    if (!targetValue) return null;
    if (actionType === "status") return { type: "status", value: targetValue as IssueStatus };
    if (actionType === "priority") return { type: "priority", value: targetValue as IssuePriority };
    if (actionType === "assignee") return { type: "assignee", value: targetValue === "__none__" ? null : targetValue };
    if (actionType === "project") return { type: "project", value: targetValue === "__none__" ? null : targetValue };
    if (actionType === "milestone") return { type: "milestone", value: targetValue === "__none__" ? null : targetValue };
    return { type: actionType, labelId: targetValue };
  }

  async function runAction(action: BulkIssueAction) {
    setError("");
    setSuccess("");
    onBusyChange(true);
    try {
      const result = await bulkUpdateIssues(selectedIssues, action);
      onUpdated(result.issues);
      onClearSelection();
      setSuccess(result.updatedCount
        ? `${action.type === "archive" ? "Archived" : action.type === "restore" ? "Restored" : "Updated"} ${result.updatedCount} of ${selectedCount} selected issues.`
        : `No changes were needed for the ${selectedCount} selected issues.`);
      setArchiveConfirmationOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The bulk update could not be saved.");
    } finally {
      onBusyChange(false);
    }
  }

  async function runCycleAction(targetCycleId: string) {
    setError("");
    setSuccess("");
    onBusyChange(true);
    const issueById = new Map(visibleIssues.map((issue) => [issue.id, issue]));
    const selected = selectedIssues.map(({ id }) => issueById.get(id)).filter((issue): issue is IssueRecord => Boolean(issue));
    let savedGroups = 0;
    try {
      if (selected.length !== selectedCount) throw new Error("Refresh the issue list and select the issues again.");
      if (selected.length > 100) throw new Error("Choose 100 or fewer issues before applying an update.");
      const destination = targetCycleId === "__none__" ? null : cycles.find((cycle) => cycle.id === targetCycleId);
      if (targetCycleId !== "__none__" && (!destination || destination.status === "Completed")) throw new Error("Choose an upcoming or active cycle.");
      const moving = selected.filter((issue) => issue.cycleId !== (destination?.id ?? null));
      for (const issue of moving) {
        const source = issue.cycleId ? cycles.find((cycle) => cycle.id === issue.cycleId) : null;
        if (source?.status === "Completed") throw new Error("Issues in completed cycles are read-only and cannot be moved.");
      }
      const groups = new Map<string, IssueRecord[]>();
      for (const issue of moving) {
        const key = issue.cycleId ?? "__backlog__";
        groups.set(key, [...(groups.get(key) ?? []), issue]);
      }
      for (const [sourceCycleId, group] of groups) {
        const issues = group.map(({ id, version }) => ({ id, version }));
        if (!destination) {
          await requestJson(`/api/cycles/${encodeURIComponent(sourceCycleId)}/issues`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issues }) });
        } else if (sourceCycleId === "__backlog__") {
          await requestJson(`/api/cycles/${encodeURIComponent(destination.id)}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issues }) });
        } else {
          await requestJson(`/api/cycles/${encodeURIComponent(sourceCycleId)}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetCycleId: destination.id, issues }) });
        }
        savedGroups += 1;
      }
      onCycleChange?.();
      onClearSelection();
      setSuccess(moving.length
        ? `Moved ${moving.length} selected issue${moving.length === 1 ? "" : "s"} ${destination ? `to ${destination.name}` : "to the backlog"}.`
        : "The selected issues are already in that cycle or the backlog.");
    } catch (cause) {
      if (savedGroups) {
        onCycleChange?.();
        onClearSelection();
        setError(`Some issue groups were moved before another group failed. The list was refreshed; select any remaining issues again. ${cause instanceof Error ? cause.message : "The move could not be completed."}`);
      } else {
        setError(cause instanceof Error ? cause.message : "The cycle assignment could not be saved.");
      }
    } finally {
      onBusyChange(false);
    }
  }

  function apply() {
    if (actionType === "cycle") {
      if (!targetValue || !selectedCount || selectedCount > 100 || busy) return;
      void runCycleAction(targetValue);
      return;
    }
    const action = createAction();
    if (!action || !selectedCount || selectedCount > 100 || busy) return;
    if (action.type === "archive") {
      setArchiveConfirmationOpen(true);
      return;
    }
    void runAction(action);
  }

  const action = createAction();
  const applyDisabled = !selectedCount || selectedCount > 100 || busy || (targetRequired && !targetValue);

  return <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:p-4" aria-label="Bulk issue actions">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Checkbox
        checked={allSelected ? true : someSelected ? "indeterminate" : false}
        disabled={busy || !visibleIssues.length}
        onCheckedChange={(checked) => onSelectAll(checked === true)}
        aria-label="Select all visible issues"
        className="size-9 rounded-md p-2"
      />
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <span className="text-xs text-muted-foreground">Select up to 100 issues per update.</span>
    </div>

    {selectedCount > 0 && <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <Select value={actionType} disabled={busy} onValueChange={(value) => { setActionType(value as IssueActionType); setTargetValue(""); setError(""); setSuccess(""); }}>
        <SelectTrigger aria-label="Bulk action" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{archivedMode ? <SelectItem value="restore">Restore</SelectItem> : <>
          <SelectItem value="status">Set status</SelectItem>
          <SelectItem value="priority">Set priority</SelectItem>
          <SelectItem value="assignee">Set assignee</SelectItem>
          <SelectItem value="label-add">Add label</SelectItem>
          <SelectItem value="label-remove">Remove label</SelectItem>
          <SelectItem value="project">Set project</SelectItem>
          <SelectItem value="milestone">Set milestone</SelectItem>
          <SelectItem value="cycle">Move to cycle or backlog</SelectItem>
          <SelectItem value="archive">Archive</SelectItem>
        </>}</SelectContent>
      </Select>

      {targetRequired ? <Select value={targetValue || undefined} disabled={busy} onValueChange={setTargetValue}>
        <SelectTrigger aria-label="Bulk action value" className="w-full"><SelectValue placeholder={actionType === "status" ? "Choose a status" : actionType === "priority" ? "Choose a priority" : actionType === "assignee" ? "Choose an assignee" : actionType === "project" ? "Choose a project" : actionType === "milestone" ? "Choose a milestone" : actionType === "cycle" ? "Choose a cycle or backlog" : "Choose a label"} /></SelectTrigger>
        <SelectContent>
          {actionType === "status" && issueStatuses.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
          {actionType === "priority" && issuePriorities.map((priority) => <SelectItem key={priority} value={priority}>{priority}</SelectItem>)}
          {actionType === "assignee" && <>
            <SelectItem value="__none__">Nobody</SelectItem>
            {members.filter((member) => member.active).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
          </>}
          {actionType === "project" && <>
            <SelectItem value="__none__">No project</SelectItem>
            {projects.filter((project) => !project.archivedAt).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
          </>}
          {actionType === "milestone" && <>
            <SelectItem value="__none__">No milestone</SelectItem>
            {milestones.filter((milestone) => !projects.find((project) => project.id === milestone.projectId)?.archivedAt).map((milestone) => {
              const projectName = projects.find((project) => project.id === milestone.projectId)?.name;
              return <SelectItem key={milestone.id} value={milestone.id}>{projectName ? `${projectName} · ` : ""}{milestone.name}</SelectItem>;
            })}
          </>}
          {actionType === "cycle" && <>
            <SelectItem value="__none__">Return to backlog</SelectItem>
            {cycles.filter((cycle) => cycle.status !== "Completed").map((cycle) => <SelectItem key={cycle.id} value={cycle.id}>{cycle.name} · {cycle.status}</SelectItem>)}
          </>}
          {(actionType === "label-add" || actionType === "label-remove") && labels.map((label) => <SelectItem key={label.id} value={label.id}>{label.name}</SelectItem>)}
        </SelectContent>
      </Select> : <div className="flex min-h-9 items-center text-sm text-muted-foreground">{actionType === "restore" ? "Restore all selected issues to active views." : "This will archive all selected issues."}</div>}

      <Button type="button" variant={actionType === "archive" ? "destructive" : "default"} disabled={applyDisabled} onClick={apply} className="min-h-10 w-full sm:w-auto">
        {busy ? "Saving…" : actionType === "archive" ? "Archive selected" : actionType === "restore" ? "Restore selected" : actionType === "cycle" ? "Move selected" : "Apply update"}
      </Button>
    </div>}

    {selectedCount > 100 && <p className="text-sm text-destructive" role="alert">Choose 100 or fewer issues before applying an update.</p>}
    {actionType === "label-add" && selectedCount > 0 && !labels.length && <p className="text-sm text-muted-foreground">Create a label before adding one to issues.</p>}
    {error && <Alert variant="destructive"><AlertCircle /><AlertTitle>Bulk update failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {success && <Alert><Check /><AlertTitle>Bulk update saved</AlertTitle><AlertDescription>{success}</AlertDescription></Alert>}

    <AlertDialog open={archiveConfirmationOpen} onOpenChange={(open) => { if (!busy) setArchiveConfirmationOpen(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {selectedCount} issues?</AlertDialogTitle>
          <AlertDialogDescription>Archived issues leave the active issue lists. You can restore them from the Archive view.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy || selectedCount > 100} onClick={() => { if (action) void runAction(action); }}>{busy ? "Archiving…" : "Archive issues"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
