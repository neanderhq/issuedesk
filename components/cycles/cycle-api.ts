import type { IssueRecord } from "@/components/issues/issue-api";
import { addDays, dateValue, formatDate, formatDateTime } from "@/lib/date-format";

export type CycleStatus = "Upcoming" | "Active" | "Completed";

export type CycleRecord = {
  id: string;
  workspaceId: string;
  name: string;
  goal: string | null;
  startDate: string;
  endDate: string;
  status: CycleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CycleIssue = IssueRecord & {
  assigneeName: string | null;
  snapshotStatus?: "completed" | "unfinished";
  carriedOverAt?: string;
};

export type CycleMetric = { issueCount: number; estimatePoints: number };

export type CycleStats = {
  scope: CycleMetric;
  completed: CycleMetric;
  remaining: CycleMetric;
  blocked: CycleMetric;
  unestimatedIssueCount: number;
  assignees: Array<{
    assigneeId: string | null;
    assigneeName: string;
    scope: CycleMetric;
    completed: CycleMetric;
    remaining: CycleMetric;
    blocked: CycleMetric;
    unestimatedIssueCount: number;
  }>;
};

export type CycleScopeChange = {
  id: string;
  action: "added" | "removed";
  actorName: string | null;
  createdAt: string;
  issue: { id: string; identifier: string; title: string };
};

export type CycleDetail = {
  cycle: CycleRecord;
  issues: CycleIssue[];
  stats: CycleStats;
  scopeChanges: CycleScopeChange[];
  snapshot: {
    completed: CycleIssue[];
    unfinished: CycleIssue[];
    carriedOver: CycleIssue[];
  } | null;
};

export { addDays, dateValue };

export function formatCycleDate(date: string) {
  return formatDate(date);
}

export function formatCycleTimestamp(value: string) {
  return formatDateTime(value);
}

export function cycleRange(cycle: CycleRecord) {
  return `${formatCycleDate(cycle.startDate)} – ${formatCycleDate(cycle.endDate)}`;
}
