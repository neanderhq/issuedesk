import { issuePriorities, issueStatuses, type IssuePriority, type IssueStatus } from "./issue-api";

export type IssueFilters = {
  q?: string;
  projectId?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string;
  labelId?: string;
  cycleId?: string;
};

const filterKeys = ["q", "projectId", "status", "priority", "assigneeId", "labelId", "cycleId"] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeIssueFilters(value: unknown): IssueFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  const filters: IssueFilters = {};
  if (typeof candidate.q === "string" && candidate.q.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(candidate.q)) filters.q = candidate.q;
  for (const key of ["projectId", "cycleId"] as const) {
    const value = candidate[key];
    if (value === "none" || (typeof value === "string" && uuidPattern.test(value))) filters[key] = value;
  }
  if (candidate.assigneeId === "none" || (typeof candidate.assigneeId === "string" && candidate.assigneeId.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(candidate.assigneeId))) filters.assigneeId = candidate.assigneeId;
  if (typeof candidate.status === "string" && issueStatuses.includes(candidate.status as IssueStatus)) filters.status = candidate.status as IssueStatus;
  if (typeof candidate.priority === "string" && issuePriorities.includes(candidate.priority as IssuePriority)) filters.priority = candidate.priority as IssuePriority;
  if (typeof candidate.labelId === "string" && uuidPattern.test(candidate.labelId)) filters.labelId = candidate.labelId;
  return filters;
}

export function issueFiltersFromSearch(search: URLSearchParams) {
  const values: Record<string, string> = {};
  for (const key of filterKeys) {
    const value = search.get(key);
    if (value !== null) values[key] = value;
  }
  return normalizeIssueFilters(values);
}

export function issueFiltersToSearch(filters: IssueFilters) {
  const search = new URLSearchParams();
  for (const key of filterKeys) {
    const value = filters[key];
    if (value !== undefined && value !== "") search.set(key, value);
  }
  return search;
}

export function hasIssueFilters(filters: IssueFilters) {
  return Object.values(filters).some((value) => value !== undefined && value !== "");
}
