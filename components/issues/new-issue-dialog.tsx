"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createIssue, issuePriorities, issueStatuses, type CreatedIssue, type IssueLabelOption, type IssueMember, type IssueMilestone, type IssuePriority, type IssueProject, type IssueRecord, type IssueStatus } from "./issue-api";

type NewIssueDialogProps = {
  members: IssueMember[];
  projects: IssueProject[];
  milestones: IssueMilestone[];
  labels: IssueLabelOption[];
  parentIssues: IssueRecord[];
  onCreated: (issue: CreatedIssue) => void;
};

const initialForm = () => ({
  title: "",
  description: "",
  status: "Backlog" as IssueStatus,
  priority: "No priority" as IssuePriority,
  assigneeId: "none",
  dueDate: "",
  estimate: "",
  projectId: "none",
  milestoneId: "none",
  parentIssueId: "none",
  labelIds: [] as string[],
});

export function NewIssueDialog({ members, projects, milestones, labels, parentIssues, onCreated }: NewIssueDialogProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const availableMilestones = milestones.filter((milestone) => milestone.projectId === form.projectId);
  const availableParents = parentIssues.filter((issue) => !issue.parentIssueId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const created = await createIssue({
        title: form.title.trim(),
        description: form.description,
        status: form.status,
        priority: form.priority,
        assigneeId: form.assigneeId === "none" ? null : form.assigneeId,
        dueDate: form.dueDate || null,
        estimate: form.estimate === "" ? null : Number(form.estimate),
        projectId: form.projectId === "none" ? null : form.projectId,
        milestoneId: form.milestoneId === "none" ? null : form.milestoneId,
        parentIssueId: form.parentIssueId === "none" ? null : form.parentIssueId,
        labelIds: form.labelIds,
      });
      onCreated(created);
      setOpen(false);
      setForm(initialForm());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The issue could not be created.");
    } finally {
      setSaving(false);
    }
  }

  function toggleLabel(labelId: string, checked: boolean) {
    setForm((current) => ({
      ...current,
      labelIds: checked ? [...current.labelIds, labelId] : current.labelIds.filter((id) => id !== labelId),
    }));
  }

  return <Dialog open={open} onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen && !saving) setError("");
  }}>
    <DialogTrigger asChild><Button size="sm"><Plus />New issue</Button></DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Create an issue</DialogTitle>
        <DialogDescription>Add a task to your workspace backlog.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="new-issue-title">Title</Label>
          <Input id="new-issue-title" autoFocus required maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="What needs to be done?" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="new-issue-description">Description</Label>
          <Textarea id="new-issue-description" maxLength={20000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Add details (optional)" className="min-h-20" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(value) => setForm({ ...form, status: value as IssueStatus })}>
              <SelectTrigger aria-label="Status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{issueStatuses.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Priority</Label>
            <Select value={form.priority} onValueChange={(value) => setForm({ ...form, priority: value as IssuePriority })}>
              <SelectTrigger aria-label="Priority" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{issuePriorities.map((priority) => <SelectItem key={priority} value={priority}>{priority}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Assignee</Label>
            <Select value={form.assigneeId} onValueChange={(value) => setForm({ ...form, assigneeId: value })}>
              <SelectTrigger aria-label="Assignee" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">Unassigned</SelectItem>{members.filter((member) => member.active).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-issue-due-date">Due date</Label>
            <Input id="new-issue-due-date" type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-issue-estimate">Estimate</Label>
            <Input id="new-issue-estimate" type="number" min={0} max={100} step={1} value={form.estimate} onChange={(event) => setForm({ ...form, estimate: event.target.value })} placeholder="Points" />
          </div>
          <div className="grid gap-2">
            <Label>Project</Label>
            <Select value={form.projectId} onValueChange={(value) => setForm({ ...form, projectId: value, milestoneId: "none" })}>
              <SelectTrigger aria-label="Project" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">No project</SelectItem>{projects.filter((project) => !project.archivedAt).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {form.projectId !== "none" && <div className="grid gap-2">
            <Label>Milestone</Label>
            <Select value={form.milestoneId} onValueChange={(value) => setForm({ ...form, milestoneId: value })}>
              <SelectTrigger aria-label="Milestone" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">No milestone</SelectItem>{availableMilestones.map((milestone) => <SelectItem key={milestone.id} value={milestone.id}>{milestone.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>}
          <div className="grid gap-2 sm:col-span-2">
            <Label>Parent issue</Label>
            <Select value={form.parentIssueId} onValueChange={(value) => setForm({ ...form, parentIssueId: value })}>
              <SelectTrigger aria-label="Parent issue" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">No parent</SelectItem>{availableParents.map((issue) => <SelectItem key={issue.id} value={issue.id}>{issue.identifier} · {issue.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {labels.length > 0 && <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Labels</legend>
          <div className="flex max-h-24 flex-wrap gap-x-4 gap-y-2 overflow-y-auto rounded-md border p-3">
            {labels.map((label) => <label key={label.id} className="flex min-w-0 items-center gap-2 text-sm">
              <Checkbox checked={form.labelIds.includes(label.id)} onCheckedChange={(checked) => toggleLabel(label.id, checked === true)} />
              <span className="break-all">{label.name}</span>
            </label>)}
          </div>
        </fieldset>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving || !form.title.trim()}>{saving ? "Creating…" : "Create issue"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
