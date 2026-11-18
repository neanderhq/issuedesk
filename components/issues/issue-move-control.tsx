"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { issueStatuses, type IssueMovePlacement, type IssueRecord, type IssueStatus } from "./issue-api";

type IssueMoveHandler = (issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) => Promise<boolean>;

export function IssueMoveControl({ issue, issues, disabled = false, onMove }: {
  issue: IssueRecord;
  issues: IssueRecord[];
  disabled?: boolean;
  onMove: IssueMoveHandler;
}) {
  const [open, setOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<IssueStatus>(issue.status);
  const currentGroup = issues.filter((item) => item.status === issue.status && !item.archivedAt);
  const currentIndex = currentGroup.findIndex((item) => item.id === issue.id);
  const sameStatus = targetStatus === issue.status;

  async function move(placement: IssueMovePlacement) {
    let relativeIssueId: string | undefined;
    if (placement === "before" || placement === "after") {
      const relativeIndex = placement === "before" ? currentIndex - 1 : currentIndex + 1;
      relativeIssueId = currentGroup[relativeIndex]?.id;
      if (!relativeIssueId) return;
    }
    if (await onMove(issue, targetStatus, placement, relativeIssueId)) setOpen(false);
  }

  return <Popover open={open} onOpenChange={(next) => {
    if (next) setTargetStatus(issue.status);
    setOpen(next);
  }}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={`Move to for ${issue.identifier}`}>Move to</Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-64 max-w-[calc(100vw-2rem)] p-3">
      <div className="grid gap-3">
        <PopoverTitle>Move {issue.identifier}</PopoverTitle>
        <Select value={targetStatus} onValueChange={(value) => setTargetStatus(value as IssueStatus)}>
          <SelectTrigger aria-label={`Move ${issue.identifier} to status`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{issueStatuses.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}</SelectContent>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={disabled || (sameStatus && currentIndex === 0)} onClick={() => void move("top")}>Top</Button>
          <Button type="button" variant="secondary" size="sm" disabled={disabled || !sameStatus || currentIndex <= 0} onClick={() => void move("before")}>Up</Button>
          <Button type="button" variant="secondary" size="sm" disabled={disabled || !sameStatus || currentIndex < 0 || currentIndex >= currentGroup.length - 1} onClick={() => void move("after")}>Down</Button>
          <Button type="button" variant="secondary" size="sm" disabled={disabled || (sameStatus && currentIndex === currentGroup.length - 1)} onClick={() => void move("bottom")}>Bottom</Button>
        </div>
        {!sameStatus && <p className="text-xs text-muted-foreground">Up and down move within the current status. Use top or bottom when changing status.</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
