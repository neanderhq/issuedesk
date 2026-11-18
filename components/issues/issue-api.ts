export const issueStatuses = ["Backlog", "Todo", "In Progress", "In Review", "Done"] as const;
export const issuePriorities = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

export type IssueStatus = typeof issueStatuses[number];
export type IssuePriority = typeof issuePriorities[number];

export type IssueLabel = { id: string; name: string; color: string };

export type IssueRecord = {
  id: string;
  identifier: string;
  issueNumber: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  dueDate: string | null;
  estimate: number | null;
  projectId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  parentIssueId: string | null;
  archivedAt: string | null;
  version: number;
  labels: IssueLabel[];
  isBlocked?: boolean;
};
export type CreatedIssue = Omit<IssueRecord, "labels"> & { labels: string[] };

export type IssueMember = { id: string; name: string; active: boolean };
export type IssueProject = { id: string; name: string; archivedAt: string | null };
export type IssueMilestone = { id: string; projectId: string; name: string };
export type IssueLabelOption = { id: string; name: string; color: string };
export type IssueCycleOption = { id: string; name: string; status: string };

export type IssueEditableField = "title" | "description" | "status" | "priority" | "assigneeId" | "dueDate" | "estimate" | "projectId" | "milestoneId" | "parentIssueId" | "labelIds";
export type IssueFieldValue = string | number | string[] | null;
export type IssueRelation = { id: string; blockerIssueId: string; blockedIssueId: string };
export type IssueComment = { id: string; issueId: string; authorId: string | null; authorName: string | null; body: string; mentionedUserIds: string[]; version: number; createdAt: string };
export type IssueActivity = { id: string; actorName: string | null; action: string; field: string | null; previousValue: unknown; nextValue: unknown; createdAt: string };
export type IssueMovePlacement = "top" | "bottom" | "before" | "after";
export type BulkIssueAction =
  | { type: "status"; value: IssueStatus }
  | { type: "priority"; value: IssuePriority }
  | { type: "assignee"; value: string | null }
  | { type: "label-add"; labelId: string }
  | { type: "label-remove"; labelId: string }
  | { type: "project"; value: string | null }
  | { type: "milestone"; value: string | null }
  | { type: "archive" }
  | { type: "restore" };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly current?: unknown) {
    super(message);
  }
}

let sessionRedirectStarted = false;

export function redirectToLoginForUnauthorized(status: number, requestUrl: string) {
  if (status !== 401 || typeof window === "undefined" || sessionRedirectStarted) return;

  let request: URL;
  try {
    request = new URL(requestUrl, window.location.origin);
  } catch {
    return;
  }
  if (request.origin !== window.location.origin || request.pathname.startsWith("/api/auth/sign-in/")) return;

  const pagePath = window.location.pathname.replace(/\/+$/, "") || "/";
  const exemptPaths = ["/login", "/signup", "/invite", "/forgot-password", "/reset-password"];
  if (exemptPaths.includes(pagePath) || pagePath.startsWith("/reset-password/")) return;

  const loginUrl = new URL("/login", window.location.origin);
  loginUrl.searchParams.set("reason", "session");
  loginUrl.searchParams.set("next", `${window.location.pathname}${window.location.search}`);
  sessionRedirectStarted = true;
  window.location.assign(`${loginUrl.pathname}${loginUrl.search}`);
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as { error?: string; current?: unknown };
  if (!response.ok) {
    redirectToLoginForUnauthorized(response.status, url);
    throw new ApiError(body.error ?? "The request could not be completed.", response.status, body.current);
  }
  return body as T;
}

export async function getIssues(filters: Record<string, string | undefined> = {}, scope: "all" | "backlog" | "mine" = "all") {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  if (scope !== "all") search.set("scope", scope);
  const body = await requestJson<{ issues: IssueRecord[] }>(`/api/issues${search.size ? `?${search}` : ""}`);
  return body.issues;
}

export type IssueCsvRowError = { column: string; message: string };
export type IssueCsvPreviewRow = { rowNumber: number; values: Record<string, string>; errors: IssueCsvRowError[] };
export type IssueCsvPreview = { columns: string[]; rows: IssueCsvPreviewRow[]; validCount: number; skippedCount: number; warnings: string[] };
export type IssueCsvImportResult = {
  importedCount: number;
  skippedCount: number;
  importedRows: Array<{ rowNumber: number; identifier: string }>;
  skippedRows: Array<{ rowNumber: number; errors: IssueCsvRowError[] }>;
  warnings: string[];
};

export function issueCsvExportUrl(filters: Record<string, string | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  return `/api/issues/csv/export${search.size ? `?${search}` : ""}`;
}

async function sendIssueCsv(file: File, action: "preview" | "import") {
  const form = new FormData();
  form.append("file", file, file.name);
  const url = `/api/issues/csv/${action}`;
  const response = await fetch(url, { method: "POST", body: form });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    redirectToLoginForUnauthorized(response.status, url);
    throw new ApiError(body.error ?? "The CSV could not be processed.", response.status);
  }
  return body;
}

export function previewIssueCsv(file: File) {
  return sendIssueCsv(file, "preview") as Promise<IssueCsvPreview>;
}

export function importIssueCsv(file: File) {
  return sendIssueCsv(file, "import") as Promise<IssueCsvImportResult>;
}

export async function downloadIssueCsv(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    redirectToLoginForUnauthorized(response.status, url);
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(body.error ?? "Issues could not be exported.", response.status);
  }
  return response.blob();
}

export async function getArchivedIssues() {
  const body = await requestJson<{ issues: IssueRecord[] }>("/api/issues?archived=true");
  return body.issues;
}

export async function getIssue(issueId: string) {
  return requestJson<IssueRecord>(`/api/issues/${encodeURIComponent(issueId)}`);
}

export async function updateIssueField(issue: IssueRecord, field: IssueEditableField, value: IssueFieldValue) {
  return requestJson<IssueRecord>(`/api/issues/${encodeURIComponent(issue.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: value, version: issue.version }),
  });
}

export async function archiveIssue(issue: IssueRecord) {
  return requestJson<IssueRecord>(`/api/issues/${encodeURIComponent(issue.id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: issue.version }),
  });
}

export async function restoreIssue(issue: IssueRecord) {
  return requestJson<IssueRecord>(`/api/issues/${encodeURIComponent(issue.id)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: issue.version }),
  });
}

export async function moveIssue(issue: IssueRecord, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) {
  return requestJson<IssueRecord>(`/api/issues/${encodeURIComponent(issue.id)}/position`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, placement, version: issue.version, ...(relativeIssueId ? { relativeIssueId } : {}) }),
  });
}

export async function bulkUpdateIssues(issues: Array<Pick<IssueRecord, "id" | "version">>, action: BulkIssueAction) {
  return requestJson<{ issues: IssueRecord[]; updatedCount: number }>("/api/issues/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issues, action }),
  });
}

export function optimisticallyMoveIssue(issues: IssueRecord[], issueId: string, status: IssueStatus, placement: IssueMovePlacement, relativeIssueId?: string) {
  const moving = issues.find((issue) => issue.id === issueId);
  if (!moving) return issues;

  const remaining = issues.filter((issue) => issue.id !== issueId);
  const target = remaining.filter((issue) => issue.status === status && !issue.archivedAt);
  const archived = remaining.filter((issue) => issue.status === status && issue.archivedAt);
  let insertionIndex = placement === "top" ? 0 : target.length;
  if (relativeIssueId) {
    const relativeIndex = target.findIndex((issue) => issue.id === relativeIssueId);
    if (relativeIndex >= 0) insertionIndex = relativeIndex + (placement === "after" ? 1 : 0);
  }
  target.splice(insertionIndex, 0, { ...moving, status });

  return issueStatuses.flatMap((groupStatus) => groupStatus === status
    ? [...target, ...archived]
    : remaining.filter((issue) => issue.status === groupStatus));
}

export async function createIssue(values: {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  dueDate: string | null;
  estimate: number | null;
  projectId: string | null;
  milestoneId: string | null;
  parentIssueId: string | null;
  labelIds: string[];
}): Promise<CreatedIssue> {
  return requestJson<CreatedIssue>("/api/issues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
}
