"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertCircle, GripVertical, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, getIssues, issuePriorities, issueStatuses, moveIssue, optimisticallyMoveIssue, requestJson, type IssueMovePlacement, type IssueRecord, type IssueStatus, type IssueMember } from "./issue-api";
import { IssueMoveControl } from "./issue-move-control";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { IssueViewControls, type SavedViewRecord } from "./issue-view-controls";
import { hasIssueFilters, type IssueFilters } from "./issue-filters";
import { useIssueFilters } from "./use-issue-filters";
import { formatDate as formatDateOnly } from "@/lib/date-format";

const columnId = (status: IssueStatus) => `column:${status}`;

const boardCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const issueCollisions = pointerCollisions.filter(({ id }) => !String(id).startsWith("column:"));
  if (issueCollisions.length) return issueCollisions;
  return pointerCollisions.length ? pointerCollisions : closestCorners(args);
};

function formatDate(date: string) {
  return formatDateOnly(date);
}

function BoardCardContent({ issue, assigneeName, issues, moveDisabled, onMove, showMove = true, dragHandle }: {
  issue: IssueRecord;
  assigneeName?: string;
  issues: IssueRecord[];
  moveDisabled: boolean;
  onMove: (issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) => Promise<boolean>;
  showMove?: boolean;
  dragHandle?: React.ReactNode;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = Boolean(issue.dueDate && issue.dueDate < today && issue.status !== "Done");

  return <div className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 shadow-sm">
    <div className="flex min-w-0 items-start gap-2">
      {dragHandle}
      <div className="grid min-w-0 flex-1 gap-1">
        <Link href={`/issue/${encodeURIComponent(issue.identifier)}`} className="w-fit max-w-full break-all font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">{issue.identifier}</Link>
        <Link href={`/issue/${encodeURIComponent(issue.identifier)}`} className="min-w-0 break-words text-sm font-medium leading-5 text-foreground hover:underline [overflow-wrap:anywhere]">{issue.title}</Link>
      </div>
      {showMove && <IssueMoveControl issue={issue} issues={issues} disabled={moveDisabled} onMove={onMove} />}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="max-w-full whitespace-normal break-all">{issue.priority || issuePriorities[0]}</Badge>
      {issue.isBlocked && <Badge variant="destructive">Blocked</Badge>}
      {issue.labels.map((label) => <Badge key={label.id} variant="secondary" className="max-w-full whitespace-normal break-all">{label.name}</Badge>)}
    </div>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
      <span className="min-w-0 break-words text-muted-foreground">{assigneeName ?? "Unassigned"}</span>
      {issue.dueDate && <time dateTime={issue.dueDate} className={overdue ? "shrink-0 text-destructive" : "shrink-0 text-muted-foreground"}>Due {formatDate(issue.dueDate)}</time>}
    </div>
  </div>;
}

function SortableIssueCard({ issue, issues, assigneeName, moveDisabled, onMove }: {
  issue: IssueRecord;
  issues: IssueRecord[];
  assigneeName?: string;
  moveDisabled: boolean;
  onMove: BoardColumnProps["onMove"];
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id, disabled: moveDisabled });

  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`min-w-0 touch-pan-y ${isDragging ? "opacity-35" : ""}`}>
    <BoardCardContent
      issue={issue}
      assigneeName={assigneeName}
      issues={issues}
      moveDisabled={moveDisabled}
      onMove={onMove}
      dragHandle={<Button {...attributes} {...listeners} ref={setActivatorNodeRef} type="button" variant="ghost" size="icon-sm" className="-ml-1 shrink-0 touch-none text-muted-foreground" aria-label={`Drag ${issue.identifier}`}><GripVertical aria-hidden="true" /></Button>}
    />
  </article>;
}

type BoardColumnProps = {
  status: IssueStatus;
  issues: IssueRecord[];
  allIssues: IssueRecord[];
  membersById: Map<string, string>;
  moveDisabled: boolean;
  onMove: (issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) => Promise<boolean>;
};

function BoardColumn({ status, issues, allIssues, membersById, moveDisabled, onMove }: BoardColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: columnId(status), data: { status } });

  return <section ref={setNodeRef} aria-label={`${status}: ${issues.length} issues`} className={`flex w-[85vw] min-w-[17rem] max-w-[20rem] shrink-0 snap-start flex-col rounded-lg border bg-muted/30 p-2 sm:w-[18rem] sm:min-w-[18rem] sm:max-w-none ${isOver ? "border-primary bg-accent/70" : ""}`}>
    <header className="flex min-w-0 items-center justify-between gap-2 px-1 pb-2 pt-1">
      <h2 className="min-w-0 break-words text-sm font-semibold">{status}</h2>
      <Badge variant="secondary" aria-label={`${issues.length} issues`}>{issues.length}</Badge>
    </header>
    <SortableContext id={`status:${status}`} items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
      <div className="grid min-h-40 min-w-0 flex-1 content-start gap-2 rounded-md p-1">
        {issues.map((issue) => <SortableIssueCard
          key={issue.id}
          issue={issue}
          issues={allIssues}
          assigneeName={issue.assigneeId ? membersById.get(issue.assigneeId) : undefined}
          moveDisabled={moveDisabled}
          onMove={onMove}
        />)}
        {!issues.length && <div className={`flex min-h-28 items-center justify-center rounded-md border border-dashed px-4 text-center text-xs text-muted-foreground ${isOver ? "border-primary bg-background" : ""}`}>
          Drop an issue here
        </div>}
      </div>
    </SortableContext>
  </section>;
}

export function IssueBoardPage({ savedView, canManageSavedView, onSavedViewChange }: { savedView?: SavedViewRecord; canManageSavedView?: boolean; onSavedViewChange?: (view: SavedViewRecord | null) => void } = {}) {
  const initialFilters = useMemo(() => (savedView?.filters ?? {}) as IssueFilters, [savedView?.filters]);
  const [filters, setFilters] = useIssueFilters(initialFilters, Boolean(savedView));
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [members, setMembers] = useState<IssueMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [moveError, setMoveError] = useState("");
  const [movingIssueId, setMovingIssueId] = useState<string | null>(null);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [rows, memberResponse] = await Promise.all([
        getIssues(filters),
        requestJson<{ members: IssueMember[] }>("/api/members"),
      ]);
      setIssues(rows);
      setMembers(memberResponse.members);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Issues could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useLiveUpdates(load);

  useEffect(() => {
    const timer = window.setTimeout(() => { setLoading(true); void load(); }, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const activeIssues = useMemo(() => issues.filter((issue) => !issue.archivedAt), [issues]);
  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);
  const issueById = useMemo(() => new Map(activeIssues.map((issue) => [issue.id, issue])), [activeIssues]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const activeIssue = activeIssueId ? issueById.get(activeIssueId) : undefined;

  async function moveBoardIssue(issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) {
    if (movingIssueId) return false;
    const previous = issues;
    setMoveError("");
    setMovingIssueId(issue.id);
    setIssues(optimisticallyMoveIssue(issues, issue.id, status, placement, relativeIssueId));
    try {
      await moveIssue(issue, status, placement, relativeIssueId);
      try {
        setIssues(await getIssues(filters));
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

  function handleDragEnd(event: DragEndEvent) {
    setActiveIssueId(null);
    const issue = issueById.get(String(event.active.id));
    const overId = event.over ? String(event.over.id) : "";
    if (!issue || !overId || overId === issue.id) return;

    if (overId.startsWith("column:")) {
      const status = overId.slice("column:".length) as IssueStatus;
      if (issueStatuses.includes(status)) void moveBoardIssue(issue, status, "bottom");
      return;
    }

    const relative = issueById.get(overId);
    if (!relative) return;
    const translated = event.active.rect.current.translated;
    const activeCenter = translated ? translated.top + translated.height / 2 : null;
    const overCenter = event.over?.rect ? event.over.rect.top + event.over.rect.height / 2 : null;
    const placement: IssueMovePlacement = activeCenter !== null && overCenter !== null
      ? activeCenter > overCenter ? "after" : "before"
      : event.delta.y > 0 ? "after" : "before";
    void moveBoardIssue(issue, relative.status, placement, relative.id);
  }

  return <section className="mx-auto w-full min-w-0 max-w-7xl overflow-hidden px-3 py-5 sm:px-6 sm:py-7">
    <IssueViewControls filters={filters} onFiltersChange={setFilters} layout="Board" savedView={savedView} canManageSavedView={canManageSavedView} onSavedViewChange={onSavedViewChange} />
    <div className="mb-4 min-w-0">
      <p className="break-words text-sm text-muted-foreground">Drag an issue to change its status or order. Use Move to for precise placement.</p>
    </div>

    {loadError && <Alert variant="destructive" className="mb-4 min-w-0">
      <AlertCircle /><AlertTitle>Could not load the board</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span className="break-words">{loadError}</span><Button size="xs" variant="outline" onClick={() => { setLoading(true); void load(); }}><RotateCw />Try again</Button></AlertDescription>
    </Alert>}
    {moveError && <Alert variant="destructive" className="mb-4 min-w-0"><AlertCircle /><AlertTitle>Issue move needs attention</AlertTitle><AlertDescription className="break-words">{moveError}</AlertDescription></Alert>}

    {loading ? <div className="flex min-w-0 gap-3 overflow-hidden" aria-label="Loading board">
      {issueStatuses.map((status) => <div key={status} className="grid w-[18rem] shrink-0 gap-2 rounded-lg border p-3"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-24 w-full" /><Skeleton className="h-20 w-full" /></div>)}
    </div> : !loadError && activeIssues.length === 0 ? <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border px-5 py-10 text-center">
      <h2 className="text-base font-medium">{hasIssueFilters(filters) ? "No issues match these filters" : "No issues yet"}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hasIssueFilters(filters) ? "Try changing a filter or clear them to see more work." : "Create an issue to start tracking your team's work."}</p>
      {hasIssueFilters(filters) && <Button variant="outline" className="mt-4" onClick={() => setFilters({})}>Clear filters</Button>}
    </div> : !loadError && <div className="w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-background p-2">
      <DndContext
        id="team-tracker-issue-board"
        sensors={sensors}
        collisionDetection={boardCollisionDetection}
        onDragStart={({ active }) => setActiveIssueId(String(active.id))}
        onDragCancel={() => setActiveIssueId(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-w-0 max-w-full snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1 pb-3 pt-1 [scrollbar-width:thin]" aria-label="Issue status columns">
          {issueStatuses.map((status) => <BoardColumn
            key={status}
            status={status}
            issues={activeIssues.filter((issue) => issue.status === status)}
            allIssues={activeIssues}
            membersById={membersById}
            moveDisabled={Boolean(movingIssueId)}
            onMove={moveBoardIssue}
          />)}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeIssue && <div className="w-[min(85vw,20rem)]">
            <BoardCardContent issue={activeIssue} assigneeName={activeIssue.assigneeId ? membersById.get(activeIssue.assigneeId) : undefined} issues={activeIssues} moveDisabled onMove={moveBoardIssue} showMove={false} />
          </div>}
        </DragOverlay>
      </DndContext>
    </div>}
  </section>;
}
