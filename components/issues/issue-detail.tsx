"use client";

import Link from "next/link";
import { MarkdownPreview } from "./markdown-preview";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Archive, ArchiveRestore, ArrowLeft, Check, Eye, EyeOff, LoaderCircle, Paperclip, Pencil, RotateCw, Send, Trash2, UserRoundPlus, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { ApiError, archiveIssue, getIssue, issuePriorities, issueStatuses, redirectToLoginForUnauthorized, requestJson, restoreIssue, updateIssueField, type IssueActivity, type IssueComment, type IssueCycleOption, type IssueEditableField, type IssueFieldValue, type IssueLabelOption, type IssueMember, type IssueMilestone, type IssueProject, type IssueRecord, type IssueRelation, type IssueStatus } from "./issue-api";
import { formatDateTime } from "@/lib/date-format";

type DetailData = { issue: IssueRecord; issues: IssueRecord[]; members: IssueMember[]; projects: IssueProject[]; milestones: IssueMilestone[]; cycles: IssueCycleOption[]; labels: IssueLabelOption[]; children: IssueRecord[]; relations: IssueRelation[]; comments: IssueComment[]; activity: IssueActivity[]; following: boolean };
type IssueAttachment = { id: string; fileName: string; contentType: string; size: number; uploadedById: string | null; uploaderName: string; createdAt: string; canDelete: boolean };
type Drafts = Partial<Record<IssueEditableField, string | number | string[] | null>>;
type IssueDraftBase = { version: number; value: IssueFieldValue };

function issueFieldValue(issue: IssueRecord, field: IssueEditableField): IssueFieldValue {
  return field === "labelIds" ? issue.labels.map((label) => label.id) : issue[field] as IssueFieldValue;
}

function sameIssueFieldValue(left: IssueFieldValue, right: IssueFieldValue) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dateText(date: string) {
  return formatDateTime(date);
}

function fileSizeText(size: number) {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB"];
  let value = size / 1024;
  let unit = units[0];
  if (value >= 1024) {
    value /= 1024;
    unit = units[1];
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function formatConflictValue(value: IssueFieldValue, field: IssueEditableField, members?: IssueMember[]) {
  if (field === "assigneeId") return value ? members?.find((member) => member.id === value)?.name ?? "Former member" : "Unassigned";
  if (field === "labelIds" && Array.isArray(value)) return value.length ? value.join(", ") : "No labels";
  return value === null || value === "" ? "Empty" : String(value);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 py-1.5"><Label className="text-xs text-muted-foreground">{label}</Label><div className="min-w-0">{children}</div></div>;
}

function EditError({ conflict, message, saving, onReload, onRetry }: { conflict: boolean; message: string; saving: boolean; onReload: () => void; onRetry: () => void }) {
  return <Alert variant={conflict ? "destructive" : "default"} className="min-w-0 py-2"><AlertCircle /><AlertTitle>{conflict ? "Someone else changed this" : "Could not save change"}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2"><span className="break-words">{conflict ? "Your edit is still here. Reload the latest version before trying again." : message}</span>{conflict ? <Button size="xs" variant="outline" onClick={onReload} disabled={saving}><RotateCw />Reload issue</Button> : <Button size="xs" variant="outline" onClick={onRetry} disabled={saving}>Try again</Button>}</AlertDescription></Alert>;
}

export function IssueDetailPage({ identifier, userId }: { identifier: string; userId: string }) {
  const [data, setData] = useState<DetailData | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [editingDescription, setEditingDescription] = useState(false);
  const [previewDescription, setPreviewDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [loadError, setLoadError] = useState("");
  const [issueNotFound, setIssueNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingField, setSavingField] = useState<IssueEditableField | "cycle" | "follow" | "relation" | "archive" | "restore" | null>(null);
  const [cycleError, setCycleError] = useState("");
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: IssueEditableField; message: string; conflict: boolean; value: IssueFieldValue } | null>(null);
  const [fieldConflict, setFieldConflict] = useState<{ field: IssueEditableField; current: IssueRecord; theirs: IssueFieldValue; mine: IssueFieldValue } | null>(null);
  const [commentText, setCommentText] = useState("");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [commentError, setCommentError] = useState("");
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentConflict, setCommentConflict] = useState<{ current: IssueComment; mine: string } | null>(null);
  const commentDraftBase = useRef<{ id: string; version: number; body: string } | null>(null);
  const [savingComment, setSavingComment] = useState(false);
  const [attachments, setAttachments] = useState<IssueAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [selectedAttachment, setSelectedAttachment] = useState<File | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [newBlocker, setNewBlocker] = useState("none");
  const [newBlocked, setNewBlocked] = useState("none");
  const [childTitle, setChildTitle] = useState("");
  const [childError, setChildError] = useState("");
  const [childSaving, setChildSaving] = useState(false);
  const issueRef = useRef<IssueRecord | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const descriptionDraftInitialized = useRef(false);
  const draftBases = useRef<Partial<Record<IssueEditableField, IssueDraftBase>>>({});
  const pendingDraftFields = useRef(new Set<IssueEditableField>());

  function trackDraft(field: IssueEditableField) {
    const current = issueRef.current;
    if (!draftBases.current[field] && current) draftBases.current[field] = { version: current.version, value: issueFieldValue(current, field) };
    pendingDraftFields.current.add(field);
  }

  function clearDraft(field: IssueEditableField) {
    delete draftBases.current[field];
    pendingDraftFields.current.delete(field);
  }

  const loadAttachments = useCallback(async (issueId: string) => {
    setAttachmentError("");
    try {
      const result = await requestJson<{ attachments: IssueAttachment[] }>(`/api/issues/${encodeURIComponent(issueId)}/attachments`);
      setAttachments(result.attachments);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "Attachments could not be loaded.");
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError("");
    setIssueNotFound(false);
    try {
      const issue = await getIssue(identifier);
      const [issueRows, members, projects, milestones, cycles, labels, children, relationData, commentData, activityData, followData] = await Promise.all([
        requestJson<{ issues: IssueRecord[] }>("/api/issues"),
        requestJson<{ members: IssueMember[] }>("/api/members"),
        requestJson<{ projects: IssueProject[] }>("/api/projects"),
        requestJson<{ milestones: IssueMilestone[] }>("/api/milestones"),
        requestJson<{ cycles: IssueCycleOption[] }>("/api/cycles"),
        requestJson<{ labels: IssueLabelOption[] }>("/api/labels"),
        requestJson<{ issues: IssueRecord[] }>(`/api/issues/${encodeURIComponent(issue.id)}/sub-issues`),
        requestJson<{ relations: IssueRelation[] }>(`/api/issues/${encodeURIComponent(issue.id)}/relations`),
        requestJson<{ comments: IssueComment[] }>(`/api/issues/${encodeURIComponent(issue.id)}/comments`),
        requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(issue.id)}/activity`),
        requestJson<{ following: boolean }>(`/api/issues/${encodeURIComponent(issue.id)}/follow`),
        loadAttachments(issue.id),
      ]);
      const all = issueRows.issues;
      const fullIssue = all.find((row) => row.id === issue.id) ?? issue;
      issueRef.current = fullIssue;
      setData({ issue: fullIssue, issues: all.map((row) => row.id === fullIssue.id ? fullIssue : row), members: members.members, projects: projects.projects, milestones: milestones.milestones, cycles: cycles.cycles, labels: labels.labels, children: children.issues, relations: relationData.relations, comments: commentData.comments, activity: activityData.activity, following: followData.following });
      if (!descriptionDraftInitialized.current) {
        setDescriptionDraft(fullIssue.description);
        descriptionDraftInitialized.current = true;
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setIssueNotFound(true);
      } else {
        setLoadError(cause instanceof Error ? cause.message : "The issue could not be loaded.");
      }
    } finally { setLoading(false); }
  }, [identifier, loadAttachments]);

  useLiveUpdates(load);

  useEffect(() => { void load(); }, [load]);

  const issue = data?.issue;
  const isArchived = Boolean(issue?.archivedAt);
  const membersById = useMemo(() => new Map(data?.members.map((member) => [member.id, member.name]) ?? []), [data?.members]);
  const projectsById = useMemo(() => new Map(data?.projects.map((project) => [project.id, project.name]) ?? []), [data?.projects]);
  const milestonesForProject = data?.milestones.filter((milestone) => milestone.projectId === (drafts.projectId ?? issue?.projectId)) ?? [];
  const activeIssues = data?.issues.filter((item) => !item.archivedAt && item.id !== issue?.id) ?? [];
  const childrenDone = data?.children.filter((child) => child.status === "Done").length ?? 0;
  const blockers = data?.relations.filter((relation) => relation.blockedIssueId === issue?.id).map((relation) => ({ relation, issue: data?.issues.find((item) => item.id === relation.blockerIssueId) })).filter((item) => item.issue);
  const blockedIssues = data?.relations.filter((relation) => relation.blockerIssueId === issue?.id).map((relation) => ({ relation, issue: data?.issues.find((item) => item.id === relation.blockedIssueId) })).filter((item) => item.issue);
  const isBlocked = blockers?.some(({ issue: blocker }) => blocker && blocker.status !== "Done" && !blocker.archivedAt) ?? false;

  async function saveField(field: IssueEditableField, value: IssueFieldValue) {
    const latestIssue = issueRef.current;
    if (!latestIssue || latestIssue.archivedAt) return;
    trackDraft(field);
    const base = draftBases.current[field] ?? { version: latestIssue.version, value: issueFieldValue(latestIssue, field) };
    setDrafts((current) => ({ ...current, [field]: value }));
    setSavingField(field); setFieldError(null);
    let requestVersion = base.version;
    let requestIssue = latestIssue;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const updated = await updateIssueField({ ...requestIssue, version: requestVersion }, field, value);
          clearDraft(field);
          issueRef.current = updated;
          setData((current) => current ? { ...current, issue: updated, issues: current.issues.map((row) => row.id === updated.id ? updated : row) } : current);
          const activity = await requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(updated.id)}/activity`).catch(() => null);
          if (activity) setData((current) => current ? { ...current, activity: activity.activity } : current);
          setDrafts((current) => { const next = { ...current }; delete next[field]; return next; });
          if (field === "description") setEditingDescription(false);
          return;
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.status === 409 && cause.current && typeof cause.current === "object")) throw cause;
          const current = cause.current as IssueRecord;
          const theirs = issueFieldValue(current, field);
          issueRef.current = current;
          setData((previous) => previous ? { ...previous, issue: current, issues: previous.issues.map((row) => row.id === current.id ? current : row) } : previous);
          if (!sameIssueFieldValue(base.value, theirs)) {
            setFieldConflict({ field, current, theirs, mine: value });
            return;
          }
          requestIssue = current;
          requestVersion = current.version;
        }
      }
      setFieldError({ field, message: "This issue keeps changing. Your edit is still here; try saving again.", conflict: false, value });
    } catch (cause) {
      setFieldError({ field, message: cause instanceof Error ? cause.message : "The change could not be saved.", conflict: false, value });
    } finally { setSavingField(null); }
  }

  async function keepIssueConflict() {
    if (!fieldConflict) return;
    const { field, current, mine } = fieldConflict;
    draftBases.current[field] = { version: current.version, value: issueFieldValue(current, field) };
    issueRef.current = current;
    setFieldConflict(null);
    await saveField(field, mine);
  }

  function takeIssueConflict() {
    if (!fieldConflict) return;
    const { field, current } = fieldConflict; setFieldConflict(null); issueRef.current = current; clearDraft(field);
    setData((previous) => previous ? { ...previous, issue: current, issues: previous.issues.map((row) => row.id === current.id ? current : row) } : previous);
    setDrafts((previous) => { const next = { ...previous }; delete next[field]; return next; });
    if (field === "description") { setDescriptionDraft(current.description); setEditingDescription(false); }
  }

  async function assignCycle(targetCycleId: string) {
    const latestIssue = issueRef.current;
    if (!latestIssue || latestIssue.archivedAt) return;
    const nextCycleId = targetCycleId === "none" ? null : targetCycleId;
    if (nextCycleId === latestIssue.cycleId) return;
    const source = data?.cycles.find((cycle) => cycle.id === latestIssue.cycleId);
    const target = data?.cycles.find((cycle) => cycle.id === nextCycleId);
    if (source?.status === "Completed" || target?.status === "Completed") {
      setCycleError("Completed cycles are read-only. Choose an upcoming or active cycle.");
      return;
    }
    setSavingField("cycle");
    setCycleError("");
    try {
      const payload = JSON.stringify({ issues: [{ id: latestIssue.id, version: latestIssue.version }] });
      if (nextCycleId && !latestIssue.cycleId) {
        await requestJson(`/api/cycles/${encodeURIComponent(nextCycleId)}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
      } else if (!nextCycleId && latestIssue.cycleId) {
        await requestJson(`/api/cycles/${encodeURIComponent(latestIssue.cycleId)}/issues`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: payload });
      } else if (nextCycleId && latestIssue.cycleId) {
        await requestJson(`/api/cycles/${encodeURIComponent(latestIssue.cycleId)}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetCycleId: nextCycleId, issues: [{ id: latestIssue.id, version: latestIssue.version }] }) });
      }
      await load();
    } catch (cause) {
      setCycleError(cause instanceof ApiError && cause.status === 409
        ? "This issue or cycle changed. Reload the issue and try again."
        : cause instanceof Error ? cause.message : "The cycle assignment could not be saved.");
    } finally {
      setSavingField(null);
    }
  }

  async function reloadIssue() {
    if (!issue) return;
    setSavingField(fieldError?.field ?? null);
    try {
      const latest = await getIssue(issue.id);
      issueRef.current = latest;
      setData((current) => current ? { ...current, issue: latest, issues: current.issues.map((row) => row.id === latest.id ? latest : row) } : current);
      setFieldError(null);
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "The latest issue could not be loaded."); }
    finally { setSavingField(null); }
  }

  async function changeArchiveState(restore: boolean) {
    const currentIssue = issueRef.current;
    if (!currentIssue) return;
    setSavingField(restore ? "restore" : "archive");
    setLoadError("");
    try {
      const updated = restore ? await restoreIssue(currentIssue) : await archiveIssue(currentIssue);
      const [issueRows, activityData] = await Promise.all([
        requestJson<{ issues: IssueRecord[] }>("/api/issues"),
        requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(currentIssue.id)}/activity`),
      ]);
      issueRef.current = updated;
      setData((previous) => previous ? { ...previous, issue: updated, issues: issueRows.issues, activity: activityData.activity } : previous);
      setArchiveConfirmationOpen(false);
      setDrafts({});
      draftBases.current = {};
      pendingDraftFields.current.clear();
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : `The issue could not be ${restore ? "restored" : "archived"}.`);
    } finally {
      setSavingField(null);
    }
  }

  function fieldValue<T extends IssueFieldValue>(field: IssueEditableField, fallback: T): T {
    return Object.prototype.hasOwnProperty.call(drafts, field) ? drafts[field] as T : fallback;
  }

  async function toggleFollow() {
    if (!issue || !data) return;
    setSavingField("follow");
    try {
      const result = await requestJson<{ following: boolean }>(`/api/issues/${encodeURIComponent(issue.id)}/follow`, { method: data.following ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const activity = await requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(issue.id)}/activity`);
      setData((current) => current ? { ...current, following: result.following, activity: activity.activity } : current);
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "Follow preference could not be saved."); }
    finally { setSavingField(null); }
  }

  async function addRelation(blockerIssueId: string, blockedIssueId: string) {
    if (!issue || isArchived) return;
    setSavingField("relation"); setLoadError("");
    try {
      await requestJson(`/api/issues/${encodeURIComponent(issue.id)}/relations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockerIssueId, blockedIssueId }) });
      const [result, issueRows, activity] = await Promise.all([
        requestJson<{ relations: IssueRelation[] }>(`/api/issues/${encodeURIComponent(issue.id)}/relations`),
        requestJson<{ issues: IssueRecord[] }>("/api/issues"),
        requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(issue.id)}/activity`),
      ]);
      setData((current) => current ? { ...current, relations: result.relations, issues: issueRows.issues, activity: activity.activity } : current);
      setNewBlocker("none"); setNewBlocked("none");
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "The dependency could not be added."); }
    finally { setSavingField(null); }
  }

  async function removeRelation(relationId: string) {
    if (!issue || isArchived) return;
    setSavingField("relation");
    try {
      await requestJson(`/api/issues/${encodeURIComponent(issue.id)}/relations/${encodeURIComponent(relationId)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const [issueRows, activity] = await Promise.all([
        requestJson<{ issues: IssueRecord[] }>("/api/issues"),
        requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(issue.id)}/activity`),
      ]);
      setData((current) => current ? { ...current, relations: current.relations.filter((relation) => relation.id !== relationId), issues: issueRows.issues, activity: activity.activity } : current);
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "The dependency could not be removed."); }
    finally { setSavingField(null); }
  }

  async function createChildIssue() {
    if (!issue || isArchived || !childTitle.trim()) return;
    setChildSaving(true); setChildError("");
    try {
      await requestJson(`/api/issues/${encodeURIComponent(issue.id)}/sub-issues`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: childTitle.trim() }),
      });
      const [children, issueRows, activity] = await Promise.all([
        requestJson<{ issues: IssueRecord[] }>(`/api/issues/${encodeURIComponent(issue.id)}/sub-issues`),
        requestJson<{ issues: IssueRecord[] }>("/api/issues"),
        requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(issue.id)}/activity`),
      ]);
      setData((current) => current ? { ...current, children: children.issues, issues: issueRows.issues, activity: activity.activity } : current);
      setChildTitle("");
    } catch (cause) { setChildError(cause instanceof Error ? cause.message : "The sub-issue could not be created."); }
    finally { setChildSaving(false); }
  }

  async function postComment() {
    if (!issue || isArchived || !commentText.trim()) return;
    setCommentError("");
    try {
      await requestJson(`/api/issues/${encodeURIComponent(issue.id)}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: commentText.trim(), mentionedUserIds: mentionIds }) });
      const [comments, activity] = await Promise.all([
        requestJson<{ comments: IssueComment[] }>(`/api/issues/${encodeURIComponent(issue.id)}/comments`),
        requestJson<{ activity: IssueActivity[] }>(`/api/issues/${encodeURIComponent(issue.id)}/activity`),
      ]);
      setData((current) => current ? { ...current, comments: comments.comments, activity: activity.activity } : current);
      setCommentText(""); setMentionIds([]); setMentionQuery(null);
    } catch (cause) { setCommentError(cause instanceof Error ? cause.message : "Your comment could not be posted."); }
  }

  async function saveComment(comment: IssueComment, body: string) {
    setSavingComment(true); setCommentError("");
    try {
      const updated = await requestJson<IssueComment>(`/api/comments/${encodeURIComponent(comment.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: body.trim(), version: comment.version }) });
      setData((current) => current ? { ...current, comments: current.comments.map((item) => item.id === updated.id ? { ...item, ...updated } : item) } : current);
      setEditingComment(null); setCommentDraft(""); setCommentConflict(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.current && typeof cause.current === "object") {
        const current = cause.current as IssueComment;
        setCommentConflict({ current, mine: body });
      } else setCommentError(cause instanceof Error ? cause.message : "The comment could not be saved.");
    } finally { setSavingComment(false); }
  }

  async function resolveCommentConflict(keepMine: boolean) {
    if (!commentConflict) return;
    const pending = commentConflict; setCommentConflict(null);
    if (keepMine) { await saveComment(pending.current, pending.mine); return; }
    setData((current) => current ? { ...current, comments: current.comments.map((item) => item.id === pending.current.id ? pending.current : item) } : current);
    setEditingComment(null); setCommentDraft("");
  }

  function onCommentChange(value: string) {
    setCommentText(value);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
    setMentionQuery(match ? match[1] : null);
  }
  function insertMention(member: IssueMember) {
    setCommentText((current) => current.replace(/(?:^|\s)@[^\s@]*$/, (match) => `${match.startsWith(" ") ? " " : ""}@${member.name} `));
    setMentionIds((current) => current.includes(member.id) ? current : [...current, member.id]);
    setMentionQuery(null);
  }

  async function uploadAttachment() {
    if (!issue || isArchived || !selectedAttachment || uploadingAttachment) return;
    setUploadingAttachment(true);
    setAttachmentError("");
    try {
      const form = new FormData();
      form.append("file", selectedAttachment);
      const url = `/api/issues/${encodeURIComponent(issue.id)}/attachments`;
      const response = await fetch(url, { method: "POST", body: form });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        redirectToLoginForUnauthorized(response.status, url);
        throw new ApiError(result.error ?? "The file could not be uploaded.", response.status);
      }
      setSelectedAttachment(null);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      await load();
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "The file could not be uploaded.");
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function deleteAttachment(attachment: IssueAttachment) {
    if (!issue || isArchived || !attachment.canDelete || deletingAttachmentId) return;
    setDeletingAttachmentId(attachment.id);
    setAttachmentError("");
    try {
      await requestJson(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await load();
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "The file could not be deleted.");
    } finally {
      setDeletingAttachmentId(null);
    }
  }

  async function downloadAttachment(attachment: IssueAttachment) {
    if (downloadingAttachmentId) return;
    setDownloadingAttachmentId(attachment.id);
    setAttachmentError("");
    try {
      const url = `/api/attachments/${encodeURIComponent(attachment.id)}`;
      const response = await fetch(url);
      if (!response.ok) {
        redirectToLoginForUnauthorized(response.status, url);
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new ApiError(result.error ?? "The file could not be downloaded.", response.status);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "The file could not be downloaded.");
    } finally {
      setDownloadingAttachmentId(null);
    }
  }

  if (loading) return <main className="mx-auto grid w-full min-w-0 max-w-6xl gap-4 px-3 py-6 sm:px-6"><Skeleton className="h-7 w-1/3" /><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></main>;
  if (issueNotFound || !data || !issue) return <main className="mx-auto grid w-full min-w-0 max-w-4xl gap-4 px-3 py-6 sm:px-6"><Button asChild variant="ghost" className="w-fit"><Link href="/list"><ArrowLeft />Back to issues</Link></Button><Alert variant="destructive"><AlertCircle /><AlertTitle>{issueNotFound || !loadError ? "Issue not found" : "Could not load issue"}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{issueNotFound ? "This issue could not be found. It may have been removed or the link may be incorrect." : loadError || "This issue may have been removed or the link may be incorrect."}<Button size="xs" variant="outline" onClick={() => { setLoading(true); void load(); }}><RotateCw />Try again</Button></AlertDescription></Alert></main>;

  const title = fieldValue("title", issue.title) as string;
  const status = fieldValue("status", issue.status) as IssueStatus;
  const priority = fieldValue("priority", issue.priority) as string;
  const assigneeId = fieldValue("assigneeId", issue.assigneeId) as string | null;
  const dueDate = fieldValue("dueDate", issue.dueDate) as string | null;
  const estimate = fieldValue("estimate", issue.estimate) as number | null;
  const projectId = fieldValue("projectId", issue.projectId) as string | null;
  const milestoneId = fieldValue("milestoneId", issue.milestoneId) as string | null;
  const archivedCurrentProject = data.projects.find((project) => project.id === issue.projectId && project.archivedAt);
  const parentIssueId = fieldValue("parentIssueId", issue.parentIssueId) as string | null;
  const selectedLabelIds = (fieldValue("labelIds", issue.labels.map((label) => label.id)) as string[]);
  const busy = savingField !== null;

  return <main className="mx-auto grid w-full min-w-0 max-w-6xl gap-5 px-3 py-5 sm:px-6 sm:py-7">
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <Button asChild variant="ghost" size="sm"><Link href={isArchived ? "/archive" : "/list"}><ArrowLeft />{isArchived ? "Archive" : "All issues"}</Link></Button>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {isArchived ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void changeArchiveState(true)}><ArchiveRestore />{savingField === "restore" ? "Restoring…" : "Restore issue"}</Button> : <Button variant="outline" size="sm" disabled={busy} onClick={() => setArchiveConfirmationOpen(true)}><Archive />Archive</Button>}
        <Button variant={data.following ? "secondary" : "outline"} size="sm" disabled={savingField === "follow"} onClick={() => void toggleFollow()}>{data.following ? <><EyeOff />Unfollow</> : <><Eye />Follow</>}</Button>
      </div>
    </header>
    {isArchived && <Alert><Archive /><AlertTitle>Archived issue</AlertTitle><AlertDescription>This issue is read-only until it is restored. Its details, attachments, and history are preserved.</AlertDescription></Alert>}
    {loadError && <Alert variant="destructive"><AlertCircle /><AlertTitle>Something needs attention</AlertTitle><AlertDescription className="break-words">{loadError}</AlertDescription></Alert>}
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="grid min-w-0 content-start gap-5">
        <section className="grid min-w-0 gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="font-mono text-sm text-muted-foreground">{issue.identifier}</span>{isArchived && <Badge variant="secondary">Archived</Badge>}{isBlocked && <Badge variant="destructive">Blocked</Badge>}{savingField && savingField !== "follow" && savingField !== "relation" && <span className="flex items-center gap-1 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Saving</span>}</div>
          <Input aria-label="Issue title" maxLength={200} value={title} disabled={busy || isArchived} onChange={(event) => { trackDraft("title"); setDrafts((current) => ({ ...current, title: event.target.value })); }} onBlur={() => { if (title.trim() && title !== issue.title) void saveField("title", title.trim()); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="h-auto border-0 px-0 py-1 text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0" />
          <div className="rounded-lg border bg-card p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Description</h2>{editingDescription && <Button size="xs" variant="ghost" disabled={isArchived} onClick={() => setPreviewDescription((value) => !value)}>{previewDescription ? <><EyeOff />Edit</> : <><Eye />Preview</>}</Button>}</div>
            {editingDescription ? <div className="grid gap-3">{previewDescription ? <div className="min-h-24 rounded-md border bg-muted/20 p-3"><MarkdownPreview value={descriptionDraft} /></div> : <div className="grid gap-1"><Label htmlFor="issue-description-markdown" className="text-xs text-muted-foreground">Markdown editor</Label><Textarea id="issue-description-markdown" maxLength={20000} value={descriptionDraft} disabled={isArchived} onChange={(event) => { trackDraft("description"); setDescriptionDraft(event.target.value); }} className="min-h-36 break-all [overflow-wrap:anywhere]" /></div>}
              <div className="flex flex-wrap gap-2"><Button size="xs" disabled={busy || isArchived} onClick={() => void saveField("description", descriptionDraft)}><Check />Save description</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => { setDescriptionDraft(issue.description); setEditingDescription(false); setFieldError(null); clearDraft("description"); }}>Cancel</Button></div></div>
              : issue.description ? <div className="grid min-w-0 gap-2"><div className="min-w-0" onDoubleClick={() => { if (!isArchived) { trackDraft("description"); setDescriptionDraft(issue.description); setEditingDescription(true); } }}><MarkdownPreview value={issue.description} /></div><Button variant="ghost" size="xs" className="w-fit" disabled={isArchived} onClick={() => { trackDraft("description"); setDescriptionDraft(issue.description); setEditingDescription(true); }}>Edit description</Button></div> : <Button variant="ghost" size="sm" disabled={isArchived} onClick={() => { trackDraft("description"); setDescriptionDraft(""); setEditingDescription(true); }}>Add a description…</Button>}
          </div>
          {fieldError && <EditError conflict={fieldError.conflict} message={fieldError.message} saving={busy} onReload={() => void reloadIssue()} onRetry={() => void saveField(fieldError.field, fieldError.value)} />}
        </section>

        <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:p-4" aria-labelledby="issue-attachments-heading">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="issue-attachments-heading" className="text-sm font-semibold">Attachments</h2><span className="text-xs text-muted-foreground">{attachments.length}/10</span></div>
          {!isArchived && <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input ref={attachmentInputRef} type="file" accept=".png,.jpg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.docx,.xlsx" aria-label="Choose a file to attach" disabled={uploadingAttachment || attachments.length >= 10} onChange={(event) => setSelectedAttachment(event.target.files?.[0] ?? null)} />
            <Button size="sm" variant="outline" disabled={!selectedAttachment || uploadingAttachment || attachments.length >= 10} onClick={() => void uploadAttachment()}>{uploadingAttachment ? <><LoaderCircle className="animate-spin" />Uploading…</> : <><Paperclip />Upload file</>}</Button>
          </div>}
          {isArchived && <p className="text-xs text-muted-foreground">Attachments are read-only while the issue is archived.</p>}
          {attachmentError && <Alert variant="destructive" className="py-2"><AlertCircle /><AlertTitle>Attachment error</AlertTitle><AlertDescription className="break-words">{attachmentError}</AlertDescription></Alert>}
          {attachments.length ? <ul className="divide-y rounded-md border">{attachments.map((attachment) => <li key={attachment.id} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{attachment.fileName}</p><p className="mt-0.5 text-xs text-muted-foreground">{fileSizeText(attachment.size)} · Uploaded by {attachment.uploaderName} · {dateText(attachment.createdAt)}</p></div>
            <div className="flex shrink-0 items-center gap-1"><Button type="button" size="xs" variant="outline" disabled={downloadingAttachmentId !== null} onClick={() => void downloadAttachment(attachment)}>{downloadingAttachmentId === attachment.id ? <><LoaderCircle className="animate-spin" />Downloading…</> : "Download"}</Button>{attachment.canDelete && <Button type="button" size="icon-xs" variant="ghost" aria-label={`Delete ${attachment.fileName}`} disabled={isArchived || deletingAttachmentId !== null} onClick={() => void deleteAttachment(attachment)}>{deletingAttachmentId === attachment.id ? <LoaderCircle className="animate-spin" /> : <Trash2 />}</Button>}</div>
          </li>)}</ul> : !attachmentError && <p className="text-sm text-muted-foreground">No attachments yet.</p>}
          {attachments.length >= 10 && !isArchived && <p className="text-xs text-muted-foreground">This issue has reached the 10-attachment limit.</p>}
        </section>

        <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Sub-issues</h2><span className="text-xs text-muted-foreground">{childrenDone} of {data.children.length} complete</span></div>
          {data.children.length ? <div className="divide-y">{data.children.map((child) => <Link key={child.id} href={`/issue/${encodeURIComponent(child.identifier)}`} className="flex min-w-0 flex-wrap items-center gap-2 py-2 text-sm hover:underline"><span className="font-mono text-xs text-muted-foreground">{child.identifier}</span><span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{child.title}</span><Badge variant="outline">{child.status}</Badge></Link>)}</div> : <p className="text-sm text-muted-foreground">No sub-issues yet.</p>}
          {data.children.length > 0 && <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.round(childrenDone / data.children.length * 100)}%` }} /></div>}
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input aria-label="New sub-issue title" value={childTitle} maxLength={200} disabled={isArchived} onChange={(event) => setChildTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createChildIssue(); } }} placeholder="Add a sub-issue…" />
            <Button variant="outline" size="sm" disabled={isArchived || childSaving || !childTitle.trim()} onClick={() => void createChildIssue()}><UserRoundPlus />Add sub-issue</Button>
          </div>{childError && <p role="alert" className="text-xs text-destructive">{childError}</p>}
        </section>

        <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Dependencies</h2>
          <div className="grid gap-2">{blockers?.map(({ relation, issue: related }) => related && <div key={relation.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Blocked by</span><Link className="min-w-0 flex-1 break-words hover:underline" href={`/issue/${encodeURIComponent(related.identifier)}`}>{related.identifier} · {related.title}</Link><Badge variant={related.status === "Done" ? "secondary" : "outline"}>{related.status}</Badge><Button size="icon-xs" variant="ghost" aria-label="Remove blocker" disabled={busy || isArchived} onClick={() => void removeRelation(relation.id)}>×</Button></div>)}
            {blockedIssues?.map(({ relation, issue: related }) => related && <div key={relation.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Blocks</span><Link className="min-w-0 flex-1 break-words hover:underline" href={`/issue/${encodeURIComponent(related.identifier)}`}>{related.identifier} · {related.title}</Link><Badge variant="outline">{related.status}</Badge><Button size="icon-xs" variant="ghost" aria-label="Remove blocking relation" disabled={busy || isArchived} onClick={() => void removeRelation(relation.id)}>×</Button></div>)}
            {!blockers?.length && !blockedIssues?.length && <p className="text-sm text-muted-foreground">No blocking dependencies.</p>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2"><Select value={newBlocker} disabled={isArchived} onValueChange={setNewBlocker}><SelectTrigger aria-label="Choose an issue that blocks this issue" className="w-full"><SelectValue placeholder="Blocked by…" /></SelectTrigger><SelectContent><SelectItem value="none">Blocked by…</SelectItem>{activeIssues.filter((item) => !data.relations.some((rel) => rel.blockerIssueId === item.id && rel.blockedIssueId === issue.id)).map((item) => <SelectItem key={item.id} value={item.id}>{item.identifier} · {item.title}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="outline" disabled={busy || isArchived || newBlocker === "none"} onClick={() => void addRelation(newBlocker, issue.id)}>Add blocker</Button>
            <Select value={newBlocked} disabled={isArchived} onValueChange={setNewBlocked}><SelectTrigger aria-label="Choose an issue this issue blocks" className="w-full"><SelectValue placeholder="Blocks…" /></SelectTrigger><SelectContent><SelectItem value="none">Blocks…</SelectItem>{activeIssues.filter((item) => !data.relations.some((rel) => rel.blockerIssueId === issue.id && rel.blockedIssueId === item.id)).map((item) => <SelectItem key={item.id} value={item.id}>{item.identifier} · {item.title}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="outline" disabled={busy || isArchived || newBlocked === "none"} onClick={() => void addRelation(issue.id, newBlocked)}>Add blocked issue</Button></div>
        </section>

        <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Activity</h2>
          {data.activity.length ? <ol className="grid gap-3">{data.activity.map((entry) => <li key={entry.id} className="grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)] gap-2 text-xs"><span className="mt-1.5 size-2 rounded-full bg-muted-foreground/50" /><div className="min-w-0 break-words"><span className="font-medium">{entry.actorName ?? "A former member"}</span> {activityText(entry)}<div className="mt-0.5 text-muted-foreground">{dateText(entry.createdAt)}</div></div></li>)}</ol> : <p className="text-sm text-muted-foreground">No activity yet.</p>}
        </section>
      </div>

      <aside className="grid min-w-0 content-start gap-4">
        <section className="grid min-w-0 gap-1 rounded-lg border bg-card p-3 sm:p-4">
          <h2 className="mb-2 text-sm font-semibold">Details</h2>
          <Field label="Status"><Select value={status} disabled={busy || isArchived} onValueChange={(value) => void saveField("status", value)}><SelectTrigger aria-label="Status" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent>{issueStatuses.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Priority"><Select value={priority} disabled={busy || isArchived} onValueChange={(value) => void saveField("priority", value)}><SelectTrigger aria-label="Priority" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent>{issuePriorities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Assignee"><Select value={assigneeId ?? "none"} disabled={busy || isArchived} onValueChange={(value) => void saveField("assigneeId", value === "none" ? null : value)}><SelectTrigger aria-label="Assignee" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Unassigned</SelectItem>{data.members.filter((member) => member.active).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Due date"><Input aria-label="Due date" type="date" className="h-8" value={dueDate ?? ""} disabled={busy || isArchived} onChange={(event) => { trackDraft("dueDate"); setDrafts((current) => ({ ...current, dueDate: event.target.value || null })); }} onBlur={() => { if (dueDate !== issue.dueDate) void saveField("dueDate", dueDate); }} /></Field>
          <Field label="Estimate"><Input aria-label="Estimate" type="number" min={0} max={100} step={1} className="h-8" value={estimate ?? ""} disabled={busy || isArchived} onChange={(event) => { trackDraft("estimate"); setDrafts((current) => ({ ...current, estimate: event.target.value === "" ? null : Number(event.target.value) })); }} onBlur={() => { if (estimate !== issue.estimate) void saveField("estimate", estimate); }} /></Field>
          <Field label="Cycle"><Select value={issue.cycleId ?? "none"} disabled={busy || isArchived || data.cycles.find((cycle) => cycle.id === issue.cycleId)?.status === "Completed"} onValueChange={(value) => void assignCycle(value)}><SelectTrigger aria-label="Cycle" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Backlog · no cycle</SelectItem>{data.cycles.map((cycle) => <SelectItem key={cycle.id} value={cycle.id} disabled={cycle.status === "Completed" && cycle.id !== issue.cycleId}>{cycle.name}{cycle.status === "Completed" ? " · Completed" : ` · ${cycle.status}`}</SelectItem>)}</SelectContent></Select>{cycleError && <p className="mt-1 break-words text-xs text-destructive" role="alert">{cycleError}</p>}{data.cycles.find((cycle) => cycle.id === issue.cycleId)?.status === "Completed" && <p className="mt-1 text-xs text-muted-foreground">Issues in completed cycles are read-only.</p>}</Field>
          <Field label="Project">{archivedCurrentProject && projectId === issue.projectId ? <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 break-words text-sm">{archivedCurrentProject.name} <span className="text-muted-foreground">(archived)</span></span><Button size="xs" variant="outline" disabled={busy || isArchived} onClick={async () => { if (issue.milestoneId) await saveField("milestoneId", null); await saveField("projectId", null); }}>Remove</Button></div> : <Select value={projectId ?? "none"} disabled={busy || isArchived} onValueChange={async (value) => { const next = value === "none" ? null : value; if (next === projectId) return; if (issue.milestoneId) await saveField("milestoneId", null); await saveField("projectId", next); }}><SelectTrigger aria-label="Project" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No project</SelectItem>{data.projects.filter((project) => !project.archivedAt).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>}</Field>
          <Field label="Milestone">{archivedCurrentProject ? <span className="min-w-0 break-words text-sm">{milestoneId ? data.milestones.find((milestone) => milestone.id === milestoneId)?.name ?? "Milestone" : "No milestone"} <span className="text-muted-foreground">(archived project)</span></span> : <Select value={milestoneId ?? "none"} disabled={busy || isArchived || !projectId} onValueChange={(value) => void saveField("milestoneId", value === "none" ? null : value)}><SelectTrigger aria-label="Milestone" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No milestone</SelectItem>{milestonesForProject.map((milestone) => <SelectItem key={milestone.id} value={milestone.id}>{milestone.name}</SelectItem>)}</SelectContent></Select>}</Field>
          <Field label="Parent issue"><Select value={parentIssueId ?? "none"} disabled={busy || isArchived || data.children.length > 0} onValueChange={(value) => void saveField("parentIssueId", value === "none" ? null : value)}><SelectTrigger aria-label="Parent issue" className="h-8 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No parent</SelectItem>{activeIssues.filter((item) => !item.parentIssueId).map((item) => <SelectItem key={item.id} value={item.id}>{item.identifier} · {item.title}</SelectItem>)}</SelectContent></Select></Field>
          <Separator className="my-2" /><div className="grid gap-2"><Label className="text-xs text-muted-foreground">Labels</Label>{data.labels.length ? <div className="grid gap-2">{data.labels.map((label) => <label key={label.id} className="flex min-w-0 items-center gap-2 text-sm"><Checkbox checked={selectedLabelIds.includes(label.id)} disabled={busy || isArchived} onCheckedChange={(checked) => { const next = checked === true ? [...selectedLabelIds, label.id] : selectedLabelIds.filter((id) => id !== label.id); void saveField("labelIds", next); }} /><span className="min-w-0 break-all">{label.name}</span></label>)}</div> : <span className="text-xs text-muted-foreground">No labels available</span>}</div>
        </section>
        <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:p-4"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Comments</h2><span className="text-xs text-muted-foreground">{data.comments.length}</span></div>
          {data.comments.length ? <ol className="grid gap-3">{data.comments.map((comment) => <li key={comment.id} className="min-w-0 rounded-md bg-muted/40 p-2.5"><div className="flex flex-wrap items-center justify-between gap-1 text-xs"><span className="font-medium">{comment.authorName ?? "A former member"}</span><div className="flex items-center gap-2"><time className="text-muted-foreground">{dateText(comment.createdAt)}</time>{comment.authorId === userId && !isArchived && editingComment !== comment.id && <Button size="icon-xs" variant="ghost" aria-label="Edit comment" disabled={savingComment} onClick={() => { setEditingComment(comment.id); setCommentDraft(comment.body); }}><Pencil /></Button>}</div></div>{editingComment === comment.id ? <div className="mt-2 grid gap-2"><Textarea aria-label="Edit comment" value={commentDraft} disabled={savingComment} onChange={(event) => setCommentDraft(event.target.value)} className="min-h-20 break-all [overflow-wrap:anywhere]" /><div className="flex gap-2"><Button size="xs" disabled={savingComment || !commentDraft.trim()} onClick={() => void saveComment(comment, commentDraft)}>{savingComment ? "Saving…" : "Save comment"}</Button><Button size="xs" variant="ghost" disabled={savingComment} onClick={() => { setEditingComment(null); setCommentDraft(""); }}><X />Cancel</Button></div></div> : <div className="mt-2 min-w-0"><MarkdownPreview value={comment.body} /></div>}</li>)}</ol> : <p className="text-sm text-muted-foreground">No comments yet.</p>}
          <div className="relative grid gap-2"><Textarea aria-label="Write a comment" value={commentText} disabled={isArchived} onChange={(event) => onCommentChange(event.target.value)} placeholder="Leave a comment… Use @ to mention a teammate" className="min-h-20 break-all [overflow-wrap:anywhere]" />{mentionQuery !== null && <div className="absolute bottom-full left-0 z-10 mb-1 max-h-40 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">{data.members.filter((member) => member.active && member.name.toLowerCase().includes(mentionQuery.toLowerCase())).map((member) => <button key={member.id} type="button" className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => insertMention(member)}>{member.name}</button>)}</div>}
            <Button size="sm" disabled={isArchived || !commentText.trim()} onClick={() => void postComment()}><Send />Post comment</Button>{commentError && <p role="alert" className="break-words text-xs text-destructive">{commentError}</p>}{mentionIds.length > 0 && <p className="text-xs text-muted-foreground">Mentioning {mentionIds.length} teammate{mentionIds.length === 1 ? "" : "s"}.</p>}</div>
        </section>
      </aside>
    </div>
    <Dialog open={Boolean(fieldConflict)} onOpenChange={(open) => { if (!open) takeIssueConflict(); }}>
      <DialogContent><DialogHeader><DialogTitle>Someone else changed this</DialogTitle><DialogDescription>Your text is still here. Compare the two values, then keep yours or take the latest value.</DialogDescription></DialogHeader>
        {fieldConflict && <div className="grid gap-3 rounded-md border p-3 text-sm"><p className="font-medium">{fieldConflict.field === "assigneeId" ? "Assignee" : fieldConflict.field === "labelIds" ? "Labels" : fieldConflict.field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}</p><div><p className="text-xs text-muted-foreground">Your value</p><p className="break-words">{formatConflictValue(fieldConflict.mine, fieldConflict.field, data?.members)}</p></div><div><p className="text-xs text-muted-foreground">Latest value</p><p className="break-words">{formatConflictValue(fieldConflict.theirs, fieldConflict.field, data?.members)}</p></div></div>}
        <DialogFooter><Button type="button" variant="outline" onClick={takeIssueConflict}>Take the other value</Button><Button type="button" onClick={() => void keepIssueConflict()}>Keep my value</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(commentConflict)} onOpenChange={(open) => { if (!open) void resolveCommentConflict(false); }}>
      <DialogContent><DialogHeader><DialogTitle>Someone else changed this</DialogTitle><DialogDescription>Your comment is still here. Choose which version to keep.</DialogDescription></DialogHeader>
        {commentConflict && <div className="grid gap-3 rounded-md border p-3 text-sm"><div><p className="text-xs text-muted-foreground">Your text</p><p className="whitespace-pre-wrap break-words">{commentConflict.mine}</p></div><div><p className="text-xs text-muted-foreground">Latest text</p><p className="whitespace-pre-wrap break-words">{commentConflict.current.body}</p></div></div>}
        <DialogFooter><Button variant="outline" onClick={() => void resolveCommentConflict(false)}>Take the other text</Button><Button onClick={() => void resolveCommentConflict(true)}>Keep my text</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={archiveConfirmationOpen} onOpenChange={(open) => { if (!busy) setArchiveConfirmationOpen(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {issue.identifier}?</AlertDialogTitle>
          <AlertDialogDescription>The issue and all its details, comments, relations, attachments, and history stay saved. You can restore it from the Archive page.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void changeArchiveState(false)}>{savingField === "archive" ? "Archiving…" : "Archive issue"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </main>;
}

function activityText(entry: IssueActivity) {
  if (entry.action === "created") return "created this issue";
  if (entry.action === "attachment_added") return "added an attachment";
  if (entry.action === "attachment_removed") return "removed an attachment";
  if (entry.action === "commented") return "commented";
  if (entry.action === "comment_edited") return "edited a comment";
  if (entry.action === "comment_deleted") return "deleted a comment";
  if (entry.action === "archived") return "archived this issue";
  if (entry.action === "restored") return "restored this issue";
  if (entry.action.startsWith("blocking_relation_")) return entry.action.endsWith("added") ? "updated a blocking dependency" : "removed a blocking dependency";
  if (entry.action === "sub_issue_added") return "added a sub-issue";
  if (entry.action === "reordered") return "moved this issue";
  return `updated ${entry.field ?? "this issue"}`;
}
