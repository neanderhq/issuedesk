import { and, asc, desc, eq, exists, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { jsonError, requireWorkspaceAccess, validateMultipartMutation, validateMutationAndParse } from "./http";
import { issueCsvHeaders, parseCsv, serializeCsv } from "./issue-csv";
import {
  activity,
  comments,
  cycleMembershipHistory,
  cycleScopeEvents,
  cycles,
  issueFollowers,
  issueLabels,
  issueNumberCounters,
  issueRelations,
  issues,
  labels,
  memberships,
  milestones,
  notifications,
  projects,
  savedViews,
  user,
  workspaces,
} from "./schema";
import { multilineTextInput, textInput } from "./validation";

const uuidSchema = z.uuid();
const statuses = ["Backlog", "Todo", "In Progress", "In Review", "Done"] as const;
const priorities = ["No priority", "Urgent", "High", "Medium", "Low"] as const;
const filterChoice = z.union([uuidSchema, z.literal("none")]);
const assigneeFilter = z.union([z.literal("none"), textInput(200).min(1)]);
const issueFiltersSchema = z.object({
  q: z.string().max(200).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "Control characters are not allowed").optional(),
  projectId: filterChoice.optional(),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  assigneeId: assigneeFilter.optional(),
  labelId: uuidSchema.optional(),
  cycleId: filterChoice.optional(),
}).strict();
const issueListQuerySchema = issueFiltersSchema.extend({
  scope: z.enum(["all", "backlog", "mine"]).optional(),
  archived: z.enum(["true", "false"]).optional(),
}).strict();
const nameSchema = (maximum = 160) => textInput(maximum).min(1, "Name is required");
const savedViewCreateSchema = z.object({
  name: nameSchema(120),
  filters: issueFiltersSchema,
  layout: z.enum(["List", "Board"]),
  shared: z.boolean(),
}).strict();
const savedViewUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: nameSchema(120).optional(),
  filters: issueFiltersSchema.optional(),
  layout: z.enum(["List", "Board"]).optional(),
  shared: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "version"), "At least one saved view field must be changed");
const savedViewLayoutSchema = z.enum(["List", "Board"]);
const dateRangeError = "Date must be between 1900-01-01 and 2100-12-31";
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Date is out of range").refine((value) => value >= "1900-01-01" && value <= "2100-12-31", dateRangeError);
const dateSchema = z.union([z.null(), dateOnlySchema]);
const optionalDateSchema = dateSchema.optional();

async function validateDateMutationAndParse<T extends z.ZodType>(request: Request, schema: T) {
  const parsed = await validateMutationAndParse(request, schema);
  if ("response" in parsed && parsed.response.status === 400) {
    const payload = await parsed.response.clone().json().catch(() => ({})) as { error?: string };
    if (payload.error?.endsWith(`: ${dateRangeError}`)) return { response: jsonError(dateRangeError, 400) };
  }
  return parsed;
}
const emptyBody = z.object({}).strict();
const labelIdsSchema = z.array(uuidSchema).max(30).optional();

type Access = Extract<Awaited<ReturnType<typeof requireWorkspaceAccess>>, { membership: unknown }>;
type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function safeSavedView(row: typeof savedViews.$inferSelect) {
  const filters = issueFiltersSchema.safeParse(row.filters);
  const layout = savedViewLayoutSchema.safeParse(row.layout);
  return filters.success && layout.success ? { ...row, filters: filters.data, layout: layout.data } : null;
}

function invalidId(label: string) {
  return jsonError(`${label} id is invalid`, 400);
}

function validPathId(value: string, label: string) {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidId(label);
}

async function accessFor(request: Request) {
  return requireWorkspaceAccess(request);
}

async function issueWithLabels(database: Database | Transaction, issueId: string, workspaceId: string) {
  const [issue] = await database.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId))).limit(1);
  if (!issue) return undefined;
  const issueLabelRows = await database.select({ id: labels.id, name: labels.name, color: labels.color })
    .from(issueLabels).innerJoin(labels, eq(issueLabels.labelId, labels.id)).where(eq(issueLabels.issueId, issueId));
  const [workspace] = await database.select({ issueKeyPrefix: workspaces.issueKeyPrefix }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return { ...issue, identifier: `${workspace.issueKeyPrefix}-${issue.issueNumber}`, labels: issueLabelRows };
}

async function recordIssueActivity(transaction: Transaction, workspaceId: string, issueId: string, actorId: string, action: string, field?: string | null, previousValue?: unknown, nextValue?: unknown) {
  await transaction.insert(activity).values({
    workspaceId,
    issueId,
    actorId,
    action,
    field: field ?? null,
    previousValue: previousValue === undefined ? null : previousValue,
    nextValue: nextValue === undefined ? null : nextValue,
  });
  const isNotifiableActivity = action === "commented" || action === "archived" || (action === "updated" && ["status", "assigneeId"].includes(field ?? ""));
  if (!isNotifiableActivity) return;
  const followers = await transaction.select({ userId: issueFollowers.userId }).from(issueFollowers)
    .innerJoin(memberships, and(eq(memberships.userId, issueFollowers.userId), eq(memberships.workspaceId, workspaceId), eq(memberships.active, true)))
    .where(eq(issueFollowers.issueId, issueId));
  const recipients = followers.filter((follower) => follower.userId !== actorId);
  if (recipients.length) {
    await transaction.insert(notifications).values(recipients.map(({ userId }) => ({
      workspaceId, issueId, actorId, userId, type: "activity", payload: { action, field: field ?? null, source: action === "commented" ? "comment" : "activity" },
    })));
  }
}

async function validateActiveMember(workspaceId: string, memberId: string | null | undefined) {
  if (!memberId) return true;
  const [member] = await getDb().select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, memberId), eq(memberships.active, true))).limit(1);
  return Boolean(member);
}

async function descriptionMentionIds(transaction: Transaction, workspaceId: string, description: string) {
  if (!description.includes("@")) return [] as string[];
  const active = await transaction.select({ userId: memberships.userId, name: user.name }).from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.active, true)));
  return active.filter(({ name }) => {
    if (!name) return false;
    const pattern = new RegExp(`(^|[^\\w])@${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}(?=$|[^\\w])`, "i");
    return pattern.test(description);
  }).map(({ userId }) => userId);
}

async function notifyMentions(transaction: Transaction, workspaceId: string, issueId: string, actorId: string, mentionedIds: string[], payload: Record<string, unknown> = {}) {
  const recipients = [...new Set(mentionedIds)].filter((userId) => userId !== actorId);
  if (!recipients.length) return;
  await transaction.insert(issueFollowers).values(recipients.map((userId) => ({ issueId, userId }))).onConflictDoNothing();
  await transaction.insert(notifications).values(recipients.map((userId) => ({ workspaceId, issueId, actorId, userId, type: "mentioned", payload })));
}

async function validateIssueRelations(executor: Database | Transaction, workspaceId: string, input: {
  assigneeId?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  cycleId?: string | null;
  parentIssueId?: string | null;
  labelIds?: string[];
}, selfIssueId?: string, existingProject?: { projectId: string | null; milestoneId: string | null }) {
  if (input.assigneeId) {
    const [member] = await executor.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, input.assigneeId), eq(memberships.active, true))).limit(1);
    if (!member) return "Assignee must be an active workspace member";
  }
  if (input.projectId) {
    const [project] = await executor.select({ id: projects.id, archivedAt: projects.archivedAt }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId))).limit(1);
    if (!project) return "Project was not found in this workspace";
    if (project.archivedAt && project.id !== existingProject?.projectId) return "Project must be active to assign issues";
  }
  if (input.milestoneId) {
    const [milestone] = await executor.select({ id: milestones.id, projectId: milestones.projectId, projectArchivedAt: projects.archivedAt }).from(milestones)
      .innerJoin(projects, eq(milestones.projectId, projects.id))
      .where(and(eq(milestones.id, input.milestoneId), eq(milestones.workspaceId, workspaceId), eq(projects.workspaceId, workspaceId))).limit(1);
    if (!milestone) return "Milestone was not found in this workspace";
    const selectedProjectId = input.projectId;
    if (!selectedProjectId) return "A milestone requires its project";
    if (selectedProjectId && milestone.projectId !== selectedProjectId) return "Milestone must belong to the selected project";
    if (milestone.projectArchivedAt && milestone.id !== existingProject?.milestoneId) return "Milestone must belong to an active project";
  }
  if (input.cycleId) {
    const [cycle] = await executor.select({ id: cycles.id, status: cycles.status }).from(cycles).where(and(eq(cycles.id, input.cycleId), eq(cycles.workspaceId, workspaceId))).limit(1);
    if (!cycle) return "Cycle was not found in this workspace";
    if (cycle.status === "Completed") return "Completed cycles are read-only";
  }
  if (input.parentIssueId) {
    if (input.parentIssueId === selfIssueId) return "An issue cannot be its own parent";
    const [parent] = await executor.select({ id: issues.id, parentIssueId: issues.parentIssueId }).from(issues)
      .where(and(eq(issues.id, input.parentIssueId), eq(issues.workspaceId, workspaceId))).limit(1);
    if (!parent) return "Parent issue was not found in this workspace";
    if (parent.parentIssueId) return "Sub-issues may only be one level deep";
    if (selfIssueId) {
      const [children] = await executor.select({ id: issues.id }).from(issues).where(and(eq(issues.parentIssueId, selfIssueId), ne(issues.id, input.parentIssueId))).limit(1);
      if (children && input.parentIssueId) return "An issue with sub-issues cannot become a sub-issue";
    }
  }
  if (input.labelIds?.length) {
    const found = await executor.select({ id: labels.id }).from(labels)
      .where(and(eq(labels.workspaceId, workspaceId), inArray(labels.id, input.labelIds)));
    if (found.length !== new Set(input.labelIds).size) return "Every label must belong to this workspace and appear only once";
  }
  return null;
}

const labelBodySchema = z.object({
  name: nameSchema(80),
  color: textInput(32).regex(/^(#[\da-fA-F]{3,8}|[a-zA-Z][a-zA-Z0-9_-]{0,30})$/, "Color must be a valid color value"),
}).strict();

const projectBodySchema = z.object({
  name: nameSchema(),
  description: multilineTextInput(20000).nullable().optional(),
  leadUserId: textInput(200).nullable().optional(),
  startDate: optionalDateSchema,
  targetDate: optionalDateSchema,
}).strict();

const milestoneBodySchema = z.object({
  projectId: uuidSchema,
  name: nameSchema(),
  targetDate: optionalDateSchema,
}).strict();

const milestoneReorderSchema = z.object({
  projectId: uuidSchema,
  milestones: z.array(z.object({ id: uuidSchema, version: z.number().int().positive() }).strict())
    .refine((items) => new Set(items.map(({ id }) => id)).size === items.length, "Milestones must be unique"),
}).strict();

const cycleCreateSchema = z.object({
  name: nameSchema().optional(),
  goal: multilineTextInput(20000).nullable().optional(),
  startDate: dateOnlySchema.optional(),
  endDate: dateOnlySchema.optional(),
}).strict();
const cycleUpdateSchema = z.object({
  name: nameSchema().optional(),
  goal: multilineTextInput(20000).nullable().optional(),
  startDate: dateOnlySchema.optional(),
  endDate: dateOnlySchema.optional(),
  version: z.number().int().positive(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "version"), "At least one cycle field must be changed");
const cycleVersionSchema = z.object({ version: z.number().int().positive() }).strict();
const cycleIssuesSchema = z.object({
  issues: z.array(z.object({ id: uuidSchema, version: z.number().int().positive() }).strict()).min(1).max(100)
    .refine((selected) => new Set(selected.map(({ id }) => id)).size === selected.length, "Issues must be unique"),
}).strict();
const cycleMoveSchema = cycleIssuesSchema.extend({ targetCycleId: uuidSchema }).strict();
const cycleCloseSchema = cycleVersionSchema.extend({ unfinishedAction: z.enum(["carry", "backlog"]) }).strict();

const issueCreateSchema = z.object({
  title: textInput(200).min(1, "Title is required"),
  description: multilineTextInput(20000).optional(),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  assigneeId: textInput(200).nullable().optional(),
  dueDate: optionalDateSchema,
  estimate: z.number().int().min(0).max(100).nullable().optional(),
  projectId: uuidSchema.nullable().optional(),
  milestoneId: uuidSchema.nullable().optional(),
  cycleId: uuidSchema.nullable().optional(),
  parentIssueId: uuidSchema.nullable().optional(),
  labelIds: labelIdsSchema,
}).strict();

const csvMaximumBytes = 1024 * 1024;
const csvMaximumRows = 500;
const csvHeaderNames = new Set<string>(issueCsvHeaders);
type CsvRowError = { column: string; message: string };
type CsvImportRow = {
  rowNumber: number;
  values: Record<string, string>;
  errors: CsvRowError[];
  issue?: z.infer<typeof issueCreateSchema>;
  labelNames?: string[];
};

function normalizeCsvHeader(value: string) {
  return value.trim().replace(/^\uFEFF/, "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function validCsvDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    && value >= "1900-01-01" && value <= "2100-12-31";
}

function csvDateIsOutOfRange(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    && (value < "1900-01-01" || value > "2100-12-31");
}

async function parseIssueCsvUpload(request: Request): Promise<{ rows: CsvImportRow[]; warnings: string[] } | { response: Response }> {
  const invalid = await validateMultipartMutation(request, csvMaximumBytes + 64 * 1024, "CSV upload cannot exceed 1 MB.");
  if (invalid) return { response: invalid };

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { response: jsonError("Upload a valid CSV file.", 400) };
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) return { response: jsonError("Choose exactly one CSV file to upload.", 400) };
  const file = files[0];
  const acceptedTypes = new Set(["", "application/octet-stream", "application/csv", "application/vnd.ms-excel", "text/csv", "text/plain"]);
  const fileType = file.type.toLowerCase().split(";", 1)[0].trim();
  if (!file.name.toLowerCase().endsWith(".csv") || !acceptedTypes.has(fileType)) {
    return { response: jsonError("The uploaded file must be a CSV file.", 415) };
  }
  if (file.size > csvMaximumBytes) return { response: jsonError("CSV files must be no larger than 1 MB.", 413) };

  let text: string;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.includes(0)) return { response: jsonError("The uploaded file is not a valid text CSV.", 415) };
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return { response: jsonError("The uploaded file must be a UTF-8 CSV.", 415) };
  }

  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (error) {
    return { response: jsonError(error instanceof Error ? error.message : "The CSV format is invalid.", 400) };
  }
  if (!records.length) return { response: jsonError("The CSV must include a header row with a title column.", 400) };

  const headers = records[0].map(normalizeCsvHeader);
  const seenHeaders = new Set<string>();
  for (const header of headers) {
    if (seenHeaders.has(header)) return { response: jsonError(`The CSV contains a duplicate “${header}” column.`, 400) };
    seenHeaders.add(header);
  }
  if (!headers.includes("title")) return { response: jsonError("The CSV must include a title column.", 400) };
  const supportedColumns = issueCsvHeaders.join(", ");
  const warnings = headers.filter((header) => !csvHeaderNames.has(header))
    .map((header) => `Column "${header}" is not supported and will be ignored. Supported columns: ${supportedColumns}.`);
  const rows = records.slice(1).map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim() !== ""));
  if (rows.length > csvMaximumRows) return { response: jsonError("CSV files may contain no more than 500 data rows.", 413) };

  const importedRows = rows.map(({ cells, rowNumber }): CsvImportRow => {
    const values = Object.fromEntries([...csvHeaderNames].map((header) => {
      const index = headers.indexOf(header);
      return [header, index >= 0 ? cells[index] ?? "" : ""];
    }));
    const errors: CsvRowError[] = [];
    if (cells.length > headers.length) errors.push({ column: "row", message: "This row has more values than the header." });
    return { rowNumber, values, errors };
  });
  return { rows: importedRows, warnings };
}

async function validateCsvImportRows(rows: CsvImportRow[], workspaceId: string, issueKeyPrefix: string) {
  const database = getDb();
  const [activeMembers, activeProjects, workspaceLabels, workspaceMilestones, workspaceCycles, parentIssues] = await Promise.all([
    database.select({ id: memberships.userId, email: user.email }).from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.active, true))),
    database.select({ id: projects.id, name: projects.name }).from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt))),
    database.select({ id: labels.id, name: labels.name }).from(labels).where(eq(labels.workspaceId, workspaceId)),
    database.select({ id: milestones.id, projectId: milestones.projectId, name: milestones.name }).from(milestones)
      .where(eq(milestones.workspaceId, workspaceId)),
    database.select({ id: cycles.id, name: cycles.name, status: cycles.status }).from(cycles)
      .where(eq(cycles.workspaceId, workspaceId)),
    database.select({ id: issues.id, issueNumber: issues.issueNumber, parentIssueId: issues.parentIssueId }).from(issues)
      .where(eq(issues.workspaceId, workspaceId)),
  ]);
  const memberByEmail = new Map(activeMembers.map((member) => [member.email.toLowerCase(), member.id]));
  const projectByName = new Map(activeProjects.map((project) => [project.name.toLowerCase(), project]));
  const labelByName = new Map(workspaceLabels.map((label) => [label.name.toLowerCase(), label.id]));
  const milestoneByProjectAndName = new Map(workspaceMilestones.map((milestone) => [`${milestone.projectId}:${milestone.name.toLowerCase()}`, milestone.id]));
  const cycleByName = new Map(workspaceCycles.filter((cycle) => cycle.status !== "Completed").map((cycle) => [cycle.name.toLowerCase(), cycle.id]));
  const parentByIdentifier = new Map(parentIssues.filter((issue) => !issue.parentIssueId)
    .map((issue) => [`${issueKeyPrefix}-${issue.issueNumber}`.toLowerCase(), issue.id]));

  for (const row of rows) {
    const value = (column: string) => row.values[column] ?? "";
    const addError = (column: string, message: string) => row.errors.push({ column, message });
    const title = value("title").trim();
    if (!title) addError("title", "Title is required.");
    else if (title.length > 200) addError("title", "Title must be 200 characters or fewer.");
    else if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) addError("title", "Title contains unsupported control characters.");

    const description = value("description");
    if (description.length > 20000) addError("description", "Description must be 20,000 characters or fewer.");

    const status = value("status").trim() || "Backlog";
    row.values.status = status;
    if (!statuses.includes(status as typeof statuses[number])) addError("status", "Choose a valid workflow status.");
    const priority = value("priority").trim() || "No priority";
    row.values.priority = priority;
    if (!priorities.includes(priority as typeof priorities[number])) addError("priority", "Choose a valid priority.");

    const assigneeEmail = value("assignee email").trim().toLowerCase();
    const assigneeId = assigneeEmail ? memberByEmail.get(assigneeEmail) : null;
    if (assigneeEmail && !assigneeId) addError("assignee email", "Assignee email must belong to an active workspace member.");

    const projectName = value("project").trim();
    const project = projectName ? projectByName.get(projectName.toLowerCase()) : undefined;
    if (projectName && !project) addError("project", "Project was not found or is not active in this workspace.");

    const dueDateValue = value("due date").trim();
    const dueDate = dueDateValue || null;
    if (dueDate && !validCsvDate(dueDate)) {
      addError("due date", csvDateIsOutOfRange(dueDate) ? dateRangeError : "Date must be a real date in YYYY-MM-DD format.");
    }

    const estimateValue = value("estimate").trim();
    let estimate: number | null = null;
    if (estimateValue) {
      const isNumeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(estimateValue);
      const parsedEstimate = isNumeric ? Number(estimateValue) : Number.NaN;
      if (!Number.isFinite(parsedEstimate)) addError("estimate", "Estimate must be a number from 0 to 100.");
      else if (!Number.isInteger(parsedEstimate)) addError("estimate", "Estimate must be a whole number.");
      else if (parsedEstimate < 0 || parsedEstimate > 100) addError("estimate", "Estimate must be from 0 to 100.");
      else estimate = parsedEstimate;
    }

    const labelNames = value("labels").split(";").map((labelName) => labelName.trim()).filter(Boolean);
    if (labelNames.length > 30) addError("labels", "An issue can have no more than 30 labels.");
    if (labelNames.some((labelName) => labelName.length > 80)) addError("labels", "Label names must be 80 characters or fewer.");
    if (new Set(labelNames.map((labelName) => labelName.toLowerCase())).size !== labelNames.length) {
      addError("labels", "A label cannot appear more than once in a row.");
    }

    let parentIssueId: string | null = null;
    const parentIdentifier = value("parent identifier").trim().toLowerCase();
    if (parentIdentifier) parentIssueId = parentByIdentifier.get(parentIdentifier) ?? null;
    const milestoneName = value("milestone").trim().toLowerCase();
    const milestoneId = project && milestoneName
      ? milestoneByProjectAndName.get(`${project.id}:${milestoneName}`) ?? null
      : null;
    const cycleName = value("cycle").trim().toLowerCase();
    const cycleId = cycleName ? cycleByName.get(cycleName) ?? null : null;

    if (!row.errors.length) {
      row.issue = {
        title,
        description,
        status: status as typeof statuses[number],
        priority: priority as typeof priorities[number],
        assigneeId,
        dueDate,
        estimate,
        projectId: project?.id ?? null,
        milestoneId,
        cycleId,
        parentIssueId,
        labelIds: labelNames.map((labelName) => labelByName.get(labelName.toLowerCase())).filter((id): id is string => Boolean(id)),
      };
      row.labelNames = labelNames;
    }
  }
  return rows;
}

async function exportIssuesCsv(request: Request, access: Access) {
  const response = await issueList(request, access);
  if (!response.ok) return response;
  const { issues: selectedIssues } = await response.json() as { issues: Array<Record<string, unknown> & { id: string; assigneeId: string | null; projectId: string | null; milestoneId: string | null; cycleId: string | null; parentIssueId: string | null; labels: Array<{ name: string }>; identifier: string; title: string; description: string; status: string; priority: string; dueDate: string | null; estimate: number | null; createdAt: Date | string; updatedAt: Date | string }> };
  const ids = selectedIssues.map((issue) => issue.id);
  const lookups = async <T,>(idsToFind: string[], selectRows: (ids: string[]) => Promise<T[]>) => idsToFind.length ? selectRows(idsToFind) : [];
  const database = getDb();
  const [assignees, projectRows, milestoneRows, cycleRows, parentRows] = await Promise.all([
    lookups([...new Set(selectedIssues.map((issue) => issue.assigneeId).filter((id): id is string => Boolean(id)))], (idsToFind) => database.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, idsToFind))),
    lookups([...new Set(selectedIssues.map((issue) => issue.projectId).filter((id): id is string => Boolean(id)))], (idsToFind) => database.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, access.membership.workspaceId), inArray(projects.id, idsToFind)))),
    lookups([...new Set(selectedIssues.map((issue) => issue.milestoneId).filter((id): id is string => Boolean(id)))], (idsToFind) => database.select({ id: milestones.id, name: milestones.name }).from(milestones).where(and(eq(milestones.workspaceId, access.membership.workspaceId), inArray(milestones.id, idsToFind)))),
    lookups([...new Set(selectedIssues.map((issue) => issue.cycleId).filter((id): id is string => Boolean(id)))], (idsToFind) => database.select({ id: cycles.id, name: cycles.name }).from(cycles).where(and(eq(cycles.workspaceId, access.membership.workspaceId), inArray(cycles.id, idsToFind)))),
    lookups([...new Set(selectedIssues.map((issue) => issue.parentIssueId).filter((id): id is string => Boolean(id)))], (idsToFind) => database.select({ id: issues.id, issueNumber: issues.issueNumber }).from(issues).where(and(eq(issues.workspaceId, access.membership.workspaceId), inArray(issues.id, idsToFind)))),
  ]);
  const assigneeById = new Map(assignees.map((entry) => [entry.id, entry.email]));
  const projectById = new Map(projectRows.map((entry) => [entry.id, entry.name]));
  const milestoneById = new Map(milestoneRows.map((entry) => [entry.id, entry.name]));
  const cycleById = new Map(cycleRows.map((entry) => [entry.id, entry.name]));
  const parentById = new Map(parentRows.map((entry) => [entry.id, `${access.membership.issueKeyPrefix}-${entry.issueNumber}`]));
  const csvRows = selectedIssues.map((issue) => [
    issue.identifier,
    issue.title,
    issue.description,
    issue.status,
    issue.priority,
    issue.assigneeId ? assigneeById.get(issue.assigneeId) ?? "" : "",
    issue.labels.map(({ name }) => name).join("; "),
    issue.projectId ? projectById.get(issue.projectId) ?? "" : "",
    issue.milestoneId ? milestoneById.get(issue.milestoneId) ?? "" : "",
    issue.cycleId ? cycleById.get(issue.cycleId) ?? "" : "",
    issue.dueDate ?? "",
    issue.estimate ?? "",
    issue.parentIssueId ? parentById.get(issue.parentIssueId) ?? "" : "",
    new Date(issue.createdAt).toISOString(),
    new Date(issue.updatedAt).toISOString(),
  ]);
  const content = serializeCsv([issueCsvHeaders, ...csvRows]);
  return new Response(content, { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="team-tracker-issues.csv"',
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  } });
}

async function importIssuesCsv(request: Request, access: Access, preview: boolean) {
  const upload = await parseIssueCsvUpload(request);
  if ("response" in upload) return upload.response;
  const rows = await validateCsvImportRows(upload.rows, access.membership.workspaceId, access.membership.issueKeyPrefix);
  if (preview) {
    return Response.json({
      columns: issueCsvHeaders,
      rows: rows.map(({ rowNumber, values, errors }) => ({ rowNumber, values, errors })),
      validCount: rows.filter((row) => !row.errors.length).length,
      skippedCount: rows.filter((row) => row.errors.length).length,
      warnings: upload.warnings,
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  }

  const database = getDb();
  const importedRows: Array<{ rowNumber: number; identifier: string }> = [];
  const skippedRows = rows.filter((row) => row.errors.length).map(({ rowNumber, errors }) => ({ rowNumber, errors }));
  for (const row of rows.filter((candidate) => !candidate.errors.length)) {
    const labelNames = row.labelNames ?? [];
    try {
      if (labelNames.length) {
        const currentLabels = await database.select({ name: labels.name }).from(labels).where(eq(labels.workspaceId, access.membership.workspaceId));
        const currentNames = new Set(currentLabels.map(({ name }) => name.toLowerCase()));
        const newNames = labelNames.filter((name) => !currentNames.has(name.toLowerCase()));
        if (newNames.length) {
          await database.insert(labels).values(newNames.map((name) => ({ workspaceId: access.membership.workspaceId, name, color: "#71717a" }))).onConflictDoNothing();
        }
      }
      const matchingLabels = labelNames.length ? await database.select({ id: labels.id, name: labels.name }).from(labels)
        .where(and(eq(labels.workspaceId, access.membership.workspaceId), inArray(labels.name, labelNames))) : [];
      const labelIdByName = new Map(matchingLabels.map((label) => [label.name.toLowerCase(), label.id]));
      const issue = { ...row.issue!, labelIds: labelNames.map((name) => labelIdByName.get(name.toLowerCase())).filter((id): id is string => Boolean(id)) };
      const result = await createIssue(access, issue);
      if (!result.ok) {
        const payload = await result.json().catch(() => ({})) as { error?: string };
        skippedRows.push({ rowNumber: row.rowNumber, errors: [{ column: "row", message: payload.error ?? "The issue could not be imported." }] });
        continue;
      }
      const created = await result.json() as { identifier: string };
      importedRows.push({ rowNumber: row.rowNumber, identifier: created.identifier });
    } catch {
      skippedRows.push({ rowNumber: row.rowNumber, errors: [{ column: "row", message: "The issue could not be imported. Try again." }] });
    }
  }
  return Response.json({ importedCount: importedRows.length, skippedCount: skippedRows.length, importedRows, skippedRows, warnings: upload.warnings }, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

const issueUpdateSchema = issueCreateSchema.partial().extend({ version: z.number().int().positive() }).strict().refine((value) => Object.keys(value).some((key) => key !== "version"), "At least one issue field must be changed");
const bulkActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), value: z.enum(statuses) }).strict(),
  z.object({ type: z.literal("priority"), value: z.enum(priorities) }).strict(),
  z.object({ type: z.literal("assignee"), value: textInput(200).nullable() }).strict(),
  z.object({ type: z.literal("label-add"), labelId: uuidSchema }).strict(),
  z.object({ type: z.literal("label-remove"), labelId: uuidSchema }).strict(),
  z.object({ type: z.literal("project"), value: uuidSchema.nullable() }).strict(),
  z.object({ type: z.literal("milestone"), value: uuidSchema.nullable() }).strict(),
  z.object({ type: z.literal("archive") }).strict(),
  z.object({ type: z.literal("restore") }).strict(),
]);
const bulkIssueSchema = z.object({
  issues: z.array(z.object({ id: uuidSchema, version: z.number().int().positive() }).strict()).min(1).max(100)
    .refine((selected) => new Set(selected.map(({ id }) => id)).size === selected.length, "Issues must be unique"),
  action: bulkActionSchema,
}).strict();

const reorderSchema = z.object({
  status: z.enum(statuses),
  placement: z.enum(["before", "after", "top", "bottom"]),
  relativeIssueId: uuidSchema.optional(),
}).strict().refine((value) => ["before", "after"].includes(value.placement) === Boolean(value.relativeIssueId), {
  message: "before/after moves require relativeIssueId; top/bottom moves do not",
});

const relationBodySchema = z.object({ blockerIssueId: uuidSchema, blockedIssueId: uuidSchema }).strict();
const commentBodySchema = z.object({
  body: multilineTextInput(20000).min(1, "Comment is required"),
  mentionedUserIds: z.array(textInput(200)).max(10).default([]),
}).strict();
const commentUpdateSchema = z.object({
  body: multilineTextInput(20000).min(1, "Comment is required").optional(),
  mentionedUserIds: z.array(textInput(200)).max(10).optional(),
  version: z.number().int().positive(),
}).strict().refine((value) => value.body !== undefined || value.mentionedUserIds !== undefined, "At least one comment field must be changed");

async function listMembers(workspaceId: string) {
  return getDb().select({ id: user.id, name: user.name, role: memberships.role, active: memberships.active })
    .from(memberships).innerJoin(user, eq(memberships.userId, user.id))
    .where(eq(memberships.workspaceId, workspaceId)).orderBy(asc(user.name));
}

function dateAfter(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function lockWorkspace(transaction: Transaction, workspaceId: string) {
  await transaction.execute(sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`);
}

async function cycleName(transaction: Transaction, workspaceId: string) {
  const rows = await transaction.select({ name: cycles.name }).from(cycles).where(eq(cycles.workspaceId, workspaceId));
  const nextNumber = rows.reduce((maximum, row) => {
    const match = /^Cycle (\d+)(?:$|\s)/.exec(row.name);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  return `Cycle ${nextNumber}`;
}

async function cycleDateConflict(transaction: Transaction, workspaceId: string, startDate: string, endDate: string, exceptId?: string) {
  const conditions = [
    eq(cycles.workspaceId, workspaceId),
    sql`${cycles.startDate} <= ${endDate}`,
    sql`${cycles.endDate} >= ${startDate}`,
  ];
  if (exceptId) conditions.push(ne(cycles.id, exceptId));
  const [overlap] = await transaction.select({ id: cycles.id, name: cycles.name }).from(cycles).where(and(...conditions)).limit(1);
  return overlap;
}

async function recordCycleMembership(transaction: Transaction, workspaceId: string, cycle: typeof cycles.$inferSelect, issueId: string, action: "added" | "removed", actorId: string) {
  await transaction.insert(cycleMembershipHistory).values({ workspaceId, cycleId: cycle.id, issueId, action, actorId });
  if (cycle.status === "Active") {
    await transaction.insert(cycleScopeEvents).values({ workspaceId, cycleId: cycle.id, issueId, action, actorId });
  }
}

async function cycleIssueRows(database: Database | Transaction, workspaceId: string, issueIds: string[]) {
  if (!issueIds.length) return [];
  return database.select({
    issue: issues,
    assigneeName: user.name,
    identifier: sql<string>`concat(${workspaces.issueKeyPrefix}, '-', ${issues.issueNumber}::text)`,
  }).from(issues)
    .leftJoin(user, eq(issues.assigneeId, user.id))
    .innerJoin(workspaces, eq(issues.workspaceId, workspaces.id))
    .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, issueIds)));
}

async function cycleDetails(workspaceId: string, cycle: typeof cycles.$inferSelect) {
  const database = getDb();
  const snapshotRows = cycle.status === "Completed"
    ? await database.select().from(cycleMembershipHistory).where(and(
      eq(cycleMembershipHistory.workspaceId, workspaceId),
      eq(cycleMembershipHistory.cycleId, cycle.id),
      inArray(cycleMembershipHistory.action, ["snapshot_completed", "snapshot_unfinished", "carried_over"]),
    )).orderBy(asc(cycleMembershipHistory.createdAt))
    : [];
  const scopeIds = cycle.status === "Completed"
    ? snapshotRows.length
      ? [...new Set(snapshotRows.filter((row) => row.action !== "carried_over").map((row) => row.issueId))]
      : (await database.select({ id: issues.id }).from(issues).where(and(
        eq(issues.workspaceId, workspaceId), eq(issues.cycleId, cycle.id),
      ))).map((row) => row.id)
    : (await database.select({ id: issues.id }).from(issues).where(and(
      eq(issues.workspaceId, workspaceId), eq(issues.cycleId, cycle.id),
    ))).map((row) => row.id);
  const issueRows = await cycleIssueRows(database, workspaceId, scopeIds);
  const issuesById = new Map(issueRows.map((row) => [row.issue.id, {
    ...row.issue,
    identifier: row.identifier,
    assigneeName: row.assigneeName,
  }]));
  const snapshotStatus = new Map(snapshotRows.filter((row) => row.action !== "carried_over").map((row) => [
    row.issueId,
    row.action === "snapshot_completed" ? "completed" as const : "unfinished" as const,
  ]));
  const scopeIssues = scopeIds.map((id) => issuesById.get(id)).filter((issue): issue is NonNullable<typeof issue> => Boolean(issue));
  const blockedRows = scopeIssues.length ? await database.selectDistinct({ issueId: issueRelations.blockedIssueId })
    .from(issueRelations).innerJoin(issues, eq(issueRelations.blockerIssueId, issues.id)).where(and(
      eq(issueRelations.workspaceId, workspaceId),
      inArray(issueRelations.blockedIssueId, scopeIssues.map((issue) => issue.id)),
      ne(issues.status, "Done"), isNull(issues.archivedAt),
    )) : [];
  const blockedIds = new Set(blockedRows.map(({ issueId }) => issueId));
  const metric = (items: typeof scopeIssues) => ({
    issueCount: items.length,
    estimatePoints: items.reduce((total, issue) => total + (issue.estimate ?? 0), 0),
  });
  const isCompleted = (issue: (typeof scopeIssues)[number]) => cycle.status === "Completed"
    ? snapshotStatus.has(issue.id) ? snapshotStatus.get(issue.id) === "completed" : issue.status === "Done"
    : issue.status === "Done";
  const completedIssues = scopeIssues.filter(isCompleted);
  const remainingIssues = scopeIssues.filter((issue) => !isCompleted(issue));
  const blockedIssues = remainingIssues.filter((issue) => blockedIds.has(issue.id));
  const stats = {
    scope: metric(scopeIssues),
    completed: metric(completedIssues),
    remaining: metric(remainingIssues),
    blocked: metric(blockedIssues),
    unestimatedIssueCount: scopeIssues.filter((issue) => issue.estimate === null).length,
    assignees: [] as Array<Record<string, unknown>>,
  };
  const assigneeIds = [...new Set(scopeIssues.map((issue) => issue.assigneeId))];
  stats.assignees = assigneeIds.map((assigneeId) => {
    const assigned = scopeIssues.filter((issue) => issue.assigneeId === assigneeId);
    const assignedCompleted = assigned.filter(isCompleted);
    const assignedRemaining = assigned.filter((issue) => !isCompleted(issue));
    return {
      assigneeId,
      assigneeName: assigned[0]?.assigneeName ?? "Unassigned",
      scope: metric(assigned),
      completed: metric(assignedCompleted),
      remaining: metric(assignedRemaining),
      blocked: metric(assignedRemaining.filter((issue) => blockedIds.has(issue.id))),
      unestimatedIssueCount: assigned.filter((issue) => issue.estimate === null).length,
    };
  });
  const scopeChangeRows = await database.select({
    event: cycleScopeEvents,
    actorName: user.name,
    issueNumber: issues.issueNumber,
    issueTitle: issues.title,
    issueKeyPrefix: workspaces.issueKeyPrefix,
  }).from(cycleScopeEvents)
    .leftJoin(user, eq(cycleScopeEvents.actorId, user.id))
    .innerJoin(issues, eq(cycleScopeEvents.issueId, issues.id))
    .innerJoin(workspaces, eq(cycleScopeEvents.workspaceId, workspaces.id))
    .where(and(eq(cycleScopeEvents.workspaceId, workspaceId), eq(cycleScopeEvents.cycleId, cycle.id)))
    .orderBy(asc(cycleScopeEvents.createdAt));
  const scopeChanges = scopeChangeRows.map(({ event, actorName, issueNumber, issueTitle, issueKeyPrefix }) => ({
    ...event,
    actorName,
    issue: { id: event.issueId, identifier: `${issueKeyPrefix}-${issueNumber}`, title: issueTitle },
  }));
  const carriedRows = snapshotRows.filter((row) => row.action === "carried_over");
  const toSnapshotIssue = (row: typeof snapshotRows[number]) => {
    const issue = issuesById.get(row.issueId);
    return issue ? { ...issue, snapshotStatus: row.action === "snapshot_completed" ? "completed" : "unfinished" } : null;
  };
  const snapshot = cycle.status === "Completed" ? {
    completed: snapshotRows.length
      ? snapshotRows.filter((row) => row.action === "snapshot_completed").map(toSnapshotIssue).filter(Boolean)
      : completedIssues.map((issue) => ({ ...issue, snapshotStatus: "completed" })),
    unfinished: snapshotRows.length
      ? snapshotRows.filter((row) => row.action === "snapshot_unfinished").map(toSnapshotIssue).filter(Boolean)
      : remainingIssues.map((issue) => ({ ...issue, snapshotStatus: "unfinished" })),
    carriedOver: carriedRows.map((row) => {
      const issue = issuesById.get(row.issueId);
      return issue ? { ...issue, carriedOverAt: row.createdAt } : null;
    }).filter(Boolean),
  } : null;
  return {
    cycle,
    issues: cycle.status === "Completed"
      ? [...(snapshot?.completed ?? []), ...(snapshot?.unfinished ?? [])]
      : scopeIssues,
    stats,
    scopeChanges,
    snapshot,
  };
}

async function cyclesRoute(request: Request, access: Access) {
  const database = getDb();
  const workspaceId = access.membership.workspaceId;
  if (request.method === "GET") {
    const rows = await database.select().from(cycles).where(eq(cycles.workspaceId, workspaceId)).orderBy(desc(cycles.startDate));
    return Response.json({ cycles: rows });
  }
  if (request.method !== "POST") return jsonError("Method not allowed", 405);
  const parsed = await validateDateMutationAndParse(request, cycleCreateSchema);
  if ("response" in parsed) return parsed.response;
  return database.transaction(async (transaction) => {
    await lockWorkspace(transaction, workspaceId);
    const latestCycles = parsed.data.startDate ? [] : await transaction.select({ endDate: cycles.endDate }).from(cycles)
      .where(eq(cycles.workspaceId, workspaceId)).orderBy(desc(cycles.endDate)).limit(1);
    const latestCycle = latestCycles[0];
    const startDate = parsed.data.startDate ?? (latestCycle ? dateAfter(latestCycle.endDate, 1) : new Date().toISOString().slice(0, 10));
    const endDate = parsed.data.endDate ?? dateAfter(startDate, 13);
    if (startDate > endDate) return jsonError("Cycle start date must be on or before its end date", 400);
    const overlap = await cycleDateConflict(transaction, workspaceId, startDate, endDate);
    if (overlap) return Response.json({ error: "Cycle dates overlap an existing cycle", current: overlap }, { status: 409 });
    const [created] = await transaction.insert(cycles).values({
      workspaceId,
      name: parsed.data.name ?? await cycleName(transaction, workspaceId),
      goal: parsed.data.goal ?? null,
      startDate,
      endDate,
    }).returning();
    return Response.json(created, { status: 201 });
  });
}

async function cycleRoute(request: Request, access: Access, cycleId: string, action?: string) {
  const parsedId = validPathId(cycleId, "Cycle");
  if (parsedId instanceof Response) return parsedId;
  const database = getDb();
  const workspaceId = access.membership.workspaceId;
  if (!action && request.method === "GET") {
    const [cycle] = await database.select().from(cycles).where(and(eq(cycles.id, parsedId), eq(cycles.workspaceId, workspaceId))).limit(1);
    if (!cycle) return jsonError("Cycle not found", 404);
    return Response.json(await cycleDetails(workspaceId, cycle));
  }
  if (!action && request.method === "PATCH") {
    const parsed = await validateDateMutationAndParse(request, cycleUpdateSchema);
    if ("response" in parsed) return parsed.response;
    return database.transaction(async (transaction) => {
      await lockWorkspace(transaction, workspaceId);
      const [current] = await transaction.select().from(cycles).where(and(eq(cycles.id, parsedId), eq(cycles.workspaceId, workspaceId))).for("update").limit(1);
      if (!current) return jsonError("Cycle not found", 404);
      if (current.version !== parsed.data.version) return Response.json({ error: "Cycle has changed", current }, { status: 409 });
      if (current.status === "Completed") return jsonError("Completed cycles are read-only", 409);
      const startDate = parsed.data.startDate ?? current.startDate;
      const endDate = parsed.data.endDate ?? current.endDate;
      if (startDate > endDate) return jsonError("Cycle start date must be on or before its end date", 400);
      if (startDate !== current.startDate || endDate !== current.endDate) {
        const overlap = await cycleDateConflict(transaction, workspaceId, startDate, endDate, parsedId);
        if (overlap) return Response.json({ error: "Cycle dates overlap an existing cycle", current: overlap }, { status: 409 });
      }
      const [updated] = await transaction.update(cycles).set({
        ...parsed.data,
        startDate,
        endDate,
        version: current.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(cycles.id, parsedId), eq(cycles.version, parsed.data.version))).returning();
      if (!updated) {
        const [latest] = await transaction.select().from(cycles).where(eq(cycles.id, parsedId)).limit(1);
        return Response.json({ error: "Cycle has changed", current: latest }, { status: 409 });
      }
      return Response.json(updated);
    });
  }
  if (action === "start" && request.method === "POST") return cycleTransition(request, access, parsedId, "start");
  if (action === "close" && request.method === "POST") return cycleTransition(request, access, parsedId, "close");
  if (action === "issues" && ["POST", "DELETE"].includes(request.method)) return cycleIssuesMutation(request, access, parsedId, request.method === "POST" ? "add" : "remove");
  if (action === "move" && request.method === "POST") return cycleMoveIssues(request, access, parsedId);
  return jsonError("Method not allowed", 405);
}

async function cycleTransition(request: Request, access: Access, cycleId: string, transition: "start" | "close") {
  const schema = transition === "start" ? cycleVersionSchema : cycleCloseSchema;
  const parsed = await validateMutationAndParse(request, schema);
  if ("response" in parsed) return parsed.response;
  const database = getDb();
  const workspaceId = access.membership.workspaceId;
  const version = parsed.data.version;
  const unfinishedAction = "unfinishedAction" in parsed.data ? parsed.data.unfinishedAction : undefined;
  return database.transaction(async (transaction) => {
    await lockWorkspace(transaction, workspaceId);
    const [current] = await transaction.select().from(cycles).where(and(eq(cycles.id, cycleId), eq(cycles.workspaceId, workspaceId))).for("update").limit(1);
    if (!current) return jsonError("Cycle not found", 404);
    if (current.version !== version) return Response.json({ error: "Cycle has changed", current }, { status: 409 });
    if (current.status === "Completed") return jsonError("Completed cycles are read-only", 409);
    if (transition === "start") {
      if (current.status !== "Upcoming") return jsonError("Only an Upcoming cycle can be started", 409);
      const [active] = await transaction.select().from(cycles).where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.status, "Active"))).limit(1);
      if (active) return Response.json({ error: "Another cycle is already Active", current: active }, { status: 409 });
      const [updated] = await transaction.update(cycles).set({ status: "Active", version: current.version + 1, updatedAt: new Date() })
        .where(and(eq(cycles.id, cycleId), eq(cycles.version, version))).returning();
      return Response.json(updated);
    }
    if (current.status !== "Active") return jsonError("Only an Active cycle can be closed", 409);
    const openIssues = await transaction.select().from(issues).where(and(
      eq(issues.workspaceId, workspaceId), eq(issues.cycleId, cycleId),
    )).for("update");
    const completed = openIssues.filter((issue) => issue.status === "Done");
    const unfinished = openIssues.filter((issue) => issue.status !== "Done");
    let nextCycle: typeof cycles.$inferSelect | undefined;
    if (unfinishedAction === "carry" && unfinished.length) {
      [nextCycle] = await transaction.select().from(cycles).where(and(
        eq(cycles.workspaceId, workspaceId), eq(cycles.status, "Upcoming"), sql`${cycles.startDate} > ${current.endDate}`,
      )).orderBy(asc(cycles.startDate)).limit(1);
      if (!nextCycle) {
        const existingCycles = await transaction.select({ endDate: cycles.endDate }).from(cycles).where(eq(cycles.workspaceId, workspaceId));
        const latestEndDate = existingCycles.reduce((latest, row) => row.endDate > latest ? row.endDate : latest, current.endDate);
        const startDate = dateAfter(latestEndDate, 1);
        [nextCycle] = await transaction.insert(cycles).values({
          workspaceId,
          name: await cycleName(transaction, workspaceId),
          startDate,
          endDate: dateAfter(startDate, 14),
        }).returning();
      }
    }
    const snapshots = [
      ...completed.map((issue) => ({ workspaceId, cycleId, issueId: issue.id, action: "snapshot_completed", actorId: access.session.user.id })),
      ...unfinished.map((issue) => ({ workspaceId, cycleId, issueId: issue.id, action: "snapshot_unfinished", actorId: access.session.user.id })),
      ...(unfinishedAction === "carry" ? unfinished.map((issue) => ({ workspaceId, cycleId, issueId: issue.id, action: "carried_over", actorId: access.session.user.id })) : []),
    ];
    if (snapshots.length) await transaction.insert(cycleMembershipHistory).values(snapshots);
    for (const issue of unfinished) {
      await transaction.update(issues).set({ cycleId: nextCycle?.id ?? null, version: issue.version + 1, updatedAt: new Date() })
        .where(and(eq(issues.id, issue.id), eq(issues.version, issue.version)));
      await recordCycleMembership(transaction, workspaceId, current, issue.id, "removed", access.session.user.id);
      if (nextCycle) await recordCycleMembership(transaction, workspaceId, nextCycle, issue.id, "added", access.session.user.id);
      await recordIssueActivity(transaction, workspaceId, issue.id, access.session.user.id, "updated", "cycleId", current.id, nextCycle?.id ?? null);
    }
    const [updated] = await transaction.update(cycles).set({ status: "Completed", version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(cycles.id, cycleId), eq(cycles.version, version))).returning();
    return Response.json({ cycle: updated, carriedOverCycle: nextCycle ?? null, completedIssueIds: completed.map((issue) => issue.id), unfinishedIssueIds: unfinished.map((issue) => issue.id) });
  });
}

async function cycleIssuesMutation(request: Request, access: Access, cycleId: string, action: "add" | "remove") {
  const parsed = await validateMutationAndParse(request, cycleIssuesSchema);
  if ("response" in parsed) return parsed.response;
  const database = getDb();
  const workspaceId = access.membership.workspaceId;
  return database.transaction(async (transaction) => {
    await lockWorkspace(transaction, workspaceId);
    const [cycle] = await transaction.select().from(cycles).where(and(eq(cycles.id, cycleId), eq(cycles.workspaceId, workspaceId))).for("update").limit(1);
    if (!cycle) return jsonError("Cycle not found", 404);
    if (cycle.status === "Completed") return jsonError("Completed cycles are read-only", 409);
    const selectedIds = parsed.data.issues.map(({ id }) => id);
    const selected = await transaction.select().from(issues).where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, selectedIds))).for("update");
    if (selected.length !== selectedIds.length) return jsonError("One or more issues were not found in this workspace", 404);
    const versions = new Map(parsed.data.issues.map(({ id, version }) => [id, version]));
    if (selected.some((issue) => issue.version !== versions.get(issue.id))) return jsonError("One or more issues have changed. Refresh the list and select them again.", 409);
    if (selected.some((issue) => issue.archivedAt)) return jsonError("Archived issues cannot be added to or removed from a cycle", 400);
    if (action === "add" && selected.some((issue) => issue.cycleId !== null)) return jsonError("Issues must be in the backlog before they can be added; use move to change cycles", 409);
    if (action === "remove" && selected.some((issue) => issue.cycleId !== cycleId)) return jsonError("One or more issues are not in this cycle", 409);
    for (const issue of selected) {
      await transaction.update(issues).set({ cycleId: action === "add" ? cycleId : null, version: issue.version + 1, updatedAt: new Date() })
        .where(and(eq(issues.id, issue.id), eq(issues.version, issue.version)));
      await recordCycleMembership(transaction, workspaceId, cycle, issue.id, action === "add" ? "added" : "removed", access.session.user.id);
      await recordIssueActivity(transaction, workspaceId, issue.id, access.session.user.id, "updated", "cycleId", issue.cycleId, action === "add" ? cycleId : null);
    }
    return Response.json({ cycleId, action, issues: await cycleIssueRows(transaction, workspaceId, selectedIds) });
  });
}

async function cycleMoveIssues(request: Request, access: Access, sourceCycleId: string) {
  const parsed = await validateMutationAndParse(request, cycleMoveSchema);
  if ("response" in parsed) return parsed.response;
  if (parsed.data.targetCycleId === sourceCycleId) return jsonError("Source and target cycles must be different", 400);
  const database = getDb();
  const workspaceId = access.membership.workspaceId;
  return database.transaction(async (transaction) => {
    await lockWorkspace(transaction, workspaceId);
    const [source] = await transaction.select().from(cycles).where(and(eq(cycles.id, sourceCycleId), eq(cycles.workspaceId, workspaceId))).for("update").limit(1);
    const [target] = await transaction.select().from(cycles).where(and(eq(cycles.id, parsed.data.targetCycleId), eq(cycles.workspaceId, workspaceId))).for("update").limit(1);
    if (!source || !target) return jsonError("Source or target cycle was not found in this workspace", 404);
    if (source.status === "Completed" || target.status === "Completed") return jsonError("Completed cycles are read-only", 409);
    const selectedIds = parsed.data.issues.map(({ id }) => id);
    const selected = await transaction.select().from(issues).where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, selectedIds))).for("update");
    if (selected.length !== selectedIds.length) return jsonError("One or more issues were not found in this workspace", 404);
    const versions = new Map(parsed.data.issues.map(({ id, version }) => [id, version]));
    if (selected.some((issue) => issue.version !== versions.get(issue.id))) return jsonError("One or more issues have changed. Refresh the list and select them again.", 409);
    if (selected.some((issue) => issue.cycleId !== sourceCycleId)) return jsonError("One or more issues are not in the source cycle", 409);
    if (selected.some((issue) => issue.archivedAt)) return jsonError("Archived issues cannot be moved between cycles", 400);
    for (const issue of selected) {
      await transaction.update(issues).set({ cycleId: target.id, version: issue.version + 1, updatedAt: new Date() })
        .where(and(eq(issues.id, issue.id), eq(issues.version, issue.version)));
      await recordCycleMembership(transaction, workspaceId, source, issue.id, "removed", access.session.user.id);
      await recordCycleMembership(transaction, workspaceId, target, issue.id, "added", access.session.user.id);
      await recordIssueActivity(transaction, workspaceId, issue.id, access.session.user.id, "updated", "cycleId", source.id, target.id);
    }
    return Response.json({ sourceCycleId, targetCycleId: target.id, issues: await cycleIssueRows(transaction, workspaceId, selectedIds) });
  });
}

async function savedViewsRoute(request: Request, access: Access, viewId?: string) {
  const database = getDb();
  if (request.method === "GET" && !viewId) {
    const rows = await database.select().from(savedViews).where(and(
      eq(savedViews.workspaceId, access.membership.workspaceId),
      or(eq(savedViews.shared, true), eq(savedViews.ownerId, access.session.user.id)),
    )).orderBy(asc(savedViews.name));
    const safeRows = rows.map(safeSavedView);
    if (safeRows.some((row) => !row)) return jsonError("A saved view contains invalid data", 500);
    return Response.json({ savedViews: safeRows });
  }
  if (request.method === "POST" && !viewId) {
    const parsed = await validateMutationAndParse(request, savedViewCreateSchema);
    if ("response" in parsed) return parsed.response;
    const [created] = await database.insert(savedViews).values({
      ...parsed.data,
      workspaceId: access.membership.workspaceId,
      ownerId: access.session.user.id,
    }).returning();
    return Response.json(created, { status: 201 });
  }
  if (!viewId) return jsonError("Method not allowed", 405);
  const parsedId = validPathId(viewId, "Saved view");
  if (parsedId instanceof Response) return parsedId;
  const [current] = await database.select().from(savedViews).where(and(
    eq(savedViews.id, parsedId),
    eq(savedViews.workspaceId, access.membership.workspaceId),
  )).limit(1);
  if (!current || (!current.shared && current.ownerId !== access.session.user.id)) return jsonError("Saved view not found", 404);
  if (request.method === "GET") {
    const safeView = safeSavedView(current);
    return safeView ? Response.json(safeView) : jsonError("Saved view contains invalid data", 500);
  }
  if (current.ownerId !== access.session.user.id) return jsonError("Only the owner can change this saved view", 403);
  if (request.method === "PATCH") {
    const parsed = await validateMutationAndParse(request, savedViewUpdateSchema);
    if ("response" in parsed) return parsed.response;
    if (current.version !== parsed.data.version) return Response.json({ error: "Saved view has changed", current }, { status: 409 });
    const { version, ...changes } = parsed.data;
    const [updated] = await database.update(savedViews).set({
      ...changes,
      version: current.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(savedViews.id, parsedId),
      eq(savedViews.workspaceId, access.membership.workspaceId),
      eq(savedViews.ownerId, access.session.user.id),
      eq(savedViews.version, version),
    )).returning();
    if (!updated) {
      const [latest] = await database.select().from(savedViews).where(and(eq(savedViews.id, parsedId), eq(savedViews.workspaceId, access.membership.workspaceId))).limit(1);
      return Response.json({ error: "Saved view has changed", current: latest }, { status: 409 });
    }
    return Response.json(updated);
  }
  if (request.method === "DELETE") {
    const parsed = await validateMutationAndParse(request, z.object({ version: z.number().int().positive() }).strict());
    if ("response" in parsed) return parsed.response;
    if (current.version !== parsed.data.version) return Response.json({ error: "Saved view has changed", current }, { status: 409 });
    const deleted = await database.delete(savedViews).where(and(
      eq(savedViews.id, parsedId),
      eq(savedViews.workspaceId, access.membership.workspaceId),
      eq(savedViews.ownerId, access.session.user.id),
      eq(savedViews.version, parsed.data.version),
    )).returning({ id: savedViews.id });
    if (!deleted.length) return Response.json({ error: "Saved view has changed" }, { status: 409 });
    return Response.json({ deleted: true });
  }
  return jsonError("Method not allowed", 405);
}

async function labelsRoute(request: Request, access: Access, labelId?: string) {
  const database = getDb();
  if (request.method === "GET" && !labelId) {
    const rows = await database.select().from(labels).where(eq(labels.workspaceId, access.membership.workspaceId)).orderBy(asc(labels.name));
    return Response.json({ labels: rows });
  }
  if (request.method === "GET" && labelId) {
    const parsedId = validPathId(labelId, "Label");
    if (parsedId instanceof Response) return parsedId;
    const [label] = await database.select().from(labels).where(and(eq(labels.id, parsedId), eq(labels.workspaceId, access.membership.workspaceId))).limit(1);
    return label ? Response.json(label) : jsonError("Label not found", 404);
  }
  if (request.method === "POST" && !labelId) {
    const parsed = await validateMutationAndParse(request, labelBodySchema);
    if ("response" in parsed) return parsed.response;
    const [created] = await database.insert(labels).values({ ...parsed.data, workspaceId: access.membership.workspaceId }).returning();
    return Response.json(created, { status: 201 });
  }
  if (labelId && (request.method === "PATCH" || request.method === "DELETE")) {
    const parsedId = validPathId(labelId, "Label");
    if (parsedId instanceof Response) return parsedId;
    if (request.method === "PATCH") {
      const parsed = await validateMutationAndParse(request, labelBodySchema);
      if ("response" in parsed) return parsed.response;
      const [updated] = await database.update(labels).set(parsed.data).where(and(eq(labels.id, parsedId), eq(labels.workspaceId, access.membership.workspaceId))).returning();
      return updated ? Response.json(updated) : jsonError("Label not found", 404);
    }
    const parsed = await validateMutationAndParse(request, emptyBody);
    if ("response" in parsed) return parsed.response;
    return database.transaction(async (transaction) => {
      const [current] = await transaction.select().from(labels).where(and(eq(labels.id, parsedId), eq(labels.workspaceId, access.membership.workspaceId))).limit(1);
      if (!current) return jsonError("Label not found", 404);
      const linkedIssues = await transaction.select({ issueId: issueLabels.issueId }).from(issueLabels).innerJoin(issues, eq(issueLabels.issueId, issues.id))
        .where(and(eq(issueLabels.labelId, parsedId), eq(issues.workspaceId, access.membership.workspaceId)));
      await transaction.delete(labels).where(eq(labels.id, parsedId));
      for (const { issueId: linkedIssueId } of linkedIssues) {
        await transaction.update(issues).set({ version: sql`${issues.version} + 1` }).where(eq(issues.id, linkedIssueId));
        await recordIssueActivity(transaction, access.membership.workspaceId, linkedIssueId, access.session.user.id, "updated", "labels", current.name, null);
      }
      return Response.json({ deleted: true });
    });
  }
  return jsonError("Method not allowed", 405);
}

async function projectsRoute(request: Request, access: Access, projectId?: string) {
  const database = getDb();
  if (request.method === "GET" && !projectId) {
    const rows = await database.select().from(projects).where(eq(projects.workspaceId, access.membership.workspaceId)).orderBy(asc(projects.name));
    const progress = await projectProgress(access.membership.workspaceId);
    return Response.json({ projects: rows.map((project) => ({ ...project, progress: progress.get(project.id)?.project ?? emptyProgress() })) });
  }
  if (projectId) {
    const parsedId = validPathId(projectId, "Project");
    if (parsedId instanceof Response) return parsedId;
    if (request.method === "GET") {
      const [project] = await database.select().from(projects).where(and(eq(projects.id, parsedId), eq(projects.workspaceId, access.membership.workspaceId))).limit(1);
      if (!project) return jsonError("Project not found", 404);
      const progress = await projectProgress(access.membership.workspaceId, parsedId);
      const milestonesForProject = await database.select().from(milestones).where(and(
        eq(milestones.workspaceId, access.membership.workspaceId), eq(milestones.projectId, parsedId),
      )).orderBy(asc(milestones.position));
      return Response.json({
        ...project,
        progress: progress.get(project.id)?.project ?? emptyProgress(),
        milestones: milestonesForProject.map((milestone) => ({
          ...milestone,
          progress: progress.get(project.id)?.milestones.get(milestone.id) ?? emptyProgress(),
        })),
      });
    }
    if (request.method === "PATCH") {
      const parsed = await validateDateMutationAndParse(request, projectBodySchema.partial().extend({ version: z.number().int().positive(), archived: z.boolean().optional() }).strict()
        .refine((value) => Object.keys(value).some((key) => key !== "version"), "At least one project field must be changed"));
      if ("response" in parsed) return parsed.response;
      const { version, archived, ...fields } = parsed.data;
      if (fields.leadUserId && !await validateActiveMember(access.membership.workspaceId, fields.leadUserId)) return jsonError("Project lead must be an active workspace member", 400);
      if (fields.startDate && fields.targetDate && fields.startDate > fields.targetDate) return jsonError("Start date must be on or before target date", 400);
      const [current] = await database.select().from(projects).where(and(eq(projects.id, parsedId), eq(projects.workspaceId, access.membership.workspaceId))).limit(1);
      if (!current) return jsonError("Project not found", 404);
      if (current.version !== version) return Response.json({ error: "Project has changed", current }, { status: 409 });
      const effectiveStartDate = fields.startDate === undefined ? current.startDate : fields.startDate;
      const effectiveTargetDate = fields.targetDate === undefined ? current.targetDate : fields.targetDate;
      if (effectiveStartDate && effectiveTargetDate && effectiveStartDate > effectiveTargetDate) return jsonError("Start date must be on or before target date", 400);
      const update: Record<string, unknown> = { ...fields, version: version + 1 };
      if (archived !== undefined) update.archivedAt = archived ? new Date() : null;
      const [updated] = await database.update(projects).set(update).where(and(eq(projects.id, parsedId), eq(projects.workspaceId, access.membership.workspaceId), eq(projects.version, version))).returning();
      if (!updated) {
        const currentRecord = await database.select().from(projects).where(eq(projects.id, parsedId)).limit(1);
        return Response.json({ error: "Project has changed", current: currentRecord[0] }, { status: 409 });
      }
      return Response.json(updated);
    }
    if (request.method === "DELETE") {
      const parsed = await validateMutationAndParse(request, z.object({ version: z.number().int().positive() }).strict());
      if ("response" in parsed) return parsed.response;
      const [current] = await database.select().from(projects).where(and(eq(projects.id, parsedId), eq(projects.workspaceId, access.membership.workspaceId))).limit(1);
      if (!current) return jsonError("Project not found", 404);
      if (current.version !== parsed.data.version) return Response.json({ error: "Project has changed", current }, { status: 409 });
      const [updated] = await database.update(projects).set({ archivedAt: new Date(), version: current.version + 1 }).where(and(eq(projects.id, parsedId), eq(projects.version, current.version))).returning();
      return Response.json(updated);
    }
  }
  if (request.method === "POST" && !projectId) {
    const parsed = await validateDateMutationAndParse(request, projectBodySchema);
    if ("response" in parsed) return parsed.response;
    if (parsed.data.leadUserId && !await validateActiveMember(access.membership.workspaceId, parsed.data.leadUserId)) return jsonError("Project lead must be an active workspace member", 400);
    if (parsed.data.startDate && parsed.data.targetDate && parsed.data.startDate > parsed.data.targetDate) return jsonError("Start date must be on or before target date", 400);
    const [created] = await database.insert(projects).values({ ...parsed.data, workspaceId: access.membership.workspaceId }).returning();
    return Response.json(created, { status: 201 });
  }
  return jsonError("Method not allowed", 405);
}

async function milestonesRoute(request: Request, access: Access, milestoneId?: string) {
  const database = getDb();
  if (request.method === "GET" && !milestoneId) {
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (projectId) {
      const parsedId = validPathId(projectId, "Project");
      if (parsedId instanceof Response) return parsedId;
      const rows = await database.select().from(milestones).where(and(eq(milestones.workspaceId, access.membership.workspaceId), eq(milestones.projectId, parsedId))).orderBy(asc(milestones.position));
      return Response.json({ milestones: rows });
    }
    const rows = await database.select().from(milestones).where(eq(milestones.workspaceId, access.membership.workspaceId)).orderBy(asc(milestones.position));
    return Response.json({ milestones: rows });
  }
  if (request.method === "POST" && !milestoneId) {
    const parsed = await validateDateMutationAndParse(request, milestoneBodySchema);
    if ("response" in parsed) return parsed.response;
    const [project] = await database.select({ id: projects.id }).from(projects).where(and(eq(projects.id, parsed.data.projectId), eq(projects.workspaceId, access.membership.workspaceId))).limit(1);
    if (!project) return jsonError("Project was not found in this workspace", 400);
    const [maxPosition] = await database.select({ value: sql<number>`coalesce(max(${milestones.position}), 0)` }).from(milestones).where(eq(milestones.projectId, project.id));
    const [created] = await database.insert(milestones).values({ ...parsed.data, targetDate: parsed.data.targetDate ?? null, workspaceId: access.membership.workspaceId, position: Number(maxPosition.value) + 100 }).returning();
    return Response.json(created, { status: 201 });
  }
  if (milestoneId) {
    const parsedId = validPathId(milestoneId, "Milestone");
    if (parsedId instanceof Response) return parsedId;
    if (request.method === "GET") {
      const [milestone] = await database.select().from(milestones).where(and(eq(milestones.id, parsedId), eq(milestones.workspaceId, access.membership.workspaceId))).limit(1);
      return milestone ? Response.json(milestone) : jsonError("Milestone not found", 404);
    }
    if (request.method === "PATCH") {
      const parsed = await validateDateMutationAndParse(request, z.object({ name: nameSchema().optional(), targetDate: optionalDateSchema, version: z.number().int().positive() }).strict()
        .refine((value) => value.name !== undefined || value.targetDate !== undefined, "At least one milestone field must be changed"));
      if ("response" in parsed) return parsed.response;
      const [current] = await database.select().from(milestones).where(and(eq(milestones.id, parsedId), eq(milestones.workspaceId, access.membership.workspaceId))).limit(1);
      if (!current) return jsonError("Milestone not found", 404);
      if (current.version !== parsed.data.version) return Response.json({ error: "Milestone has changed", current }, { status: 409 });
      const [updated] = await database.update(milestones).set({
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.targetDate === undefined ? {} : { targetDate: parsed.data.targetDate }),
        version: current.version + 1,
      }).where(and(eq(milestones.id, parsedId), eq(milestones.version, current.version))).returning();
      return Response.json(updated);
    }
    if (request.method === "DELETE") {
      const parsed = await validateMutationAndParse(request, z.object({ version: z.number().int().positive() }).strict());
      if ("response" in parsed) return parsed.response;
      const [current] = await database.select().from(milestones).where(and(eq(milestones.id, parsedId), eq(milestones.workspaceId, access.membership.workspaceId))).limit(1);
      if (!current) return jsonError("Milestone not found", 404);
      if (current.version !== parsed.data.version) return Response.json({ error: "Milestone has changed", current }, { status: 409 });
      return database.transaction(async (transaction) => {
        const affectedIssues = await transaction.select({ id: issues.id, version: issues.version }).from(issues)
          .where(and(eq(issues.workspaceId, access.membership.workspaceId), eq(issues.milestoneId, parsedId)));
        for (const affectedIssue of affectedIssues) {
          await transaction.update(issues).set({ milestoneId: null, version: affectedIssue.version + 1 }).where(eq(issues.id, affectedIssue.id));
          await recordIssueActivity(transaction, access.membership.workspaceId, affectedIssue.id, access.session.user.id, "updated", "milestoneId", parsedId, null);
        }
        await transaction.delete(milestones).where(eq(milestones.id, parsedId));
        return Response.json({ deleted: true });
      });
    }
  }
  return jsonError("Method not allowed", 405);
}

async function reorderMilestones(request: Request, access: Access) {
  const parsed = await validateMutationAndParse(request, milestoneReorderSchema);
  if ("response" in parsed) return parsed.response;
  const { projectId, milestones: requestedMilestones } = parsed.data;
  return getDb().transaction(async (transaction) => {
    const [project] = await transaction.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, projectId), eq(projects.workspaceId, access.membership.workspaceId),
    )).limit(1);
    if (!project) return jsonError("Project not found", 404);
    const currentMilestones = await transaction.select().from(milestones).where(and(
      eq(milestones.projectId, projectId), eq(milestones.workspaceId, access.membership.workspaceId),
    )).for("update");
    if (currentMilestones.length !== requestedMilestones.length) return jsonError("Milestones have changed. Refresh and try again.", 409);
    const requestedById = new Map(requestedMilestones.map((milestone) => [milestone.id, milestone.version]));
    if (currentMilestones.some((milestone) => requestedById.get(milestone.id) !== milestone.version)) {
      return jsonError("Milestones have changed. Refresh and try again.", 409);
    }
    const currentById = new Map(currentMilestones.map((milestone) => [milestone.id, milestone]));
    if (requestedMilestones.some(({ id }) => !currentById.has(id))) return jsonError("Milestones have changed. Refresh and try again.", 409);
    const reordered = [];
    for (const [index, requested] of requestedMilestones.entries()) {
      const [updated] = await transaction.update(milestones).set({
        position: (index + 1) * 100,
        version: requested.version + 1,
      }).where(and(
        eq(milestones.id, requested.id), eq(milestones.workspaceId, access.membership.workspaceId),
        eq(milestones.version, requested.version),
      )).returning();
      if (!updated) return jsonError("Milestones have changed. Refresh and try again.", 409);
      reordered.push(updated);
    }
    return Response.json({ milestones: reordered });
  });
}

type IssueProgress = { totalIssues: number; doneIssues: number; totalPoints: number; donePoints: number };

function emptyProgress(): IssueProgress {
  return { totalIssues: 0, doneIssues: 0, totalPoints: 0, donePoints: 0 };
}

async function projectProgress(workspaceId: string, projectId?: string) {
  const conditions = [eq(issues.workspaceId, workspaceId), isNull(issues.archivedAt), isNotNull(issues.projectId)];
  if (projectId) conditions.push(eq(issues.projectId, projectId));
  const rows = await getDb().select({
    projectId: issues.projectId,
    milestoneId: issues.milestoneId,
    totalIssues: sql<number>`count(*)::int`,
    doneIssues: sql<number>`count(*) filter (where ${issues.status} = 'Done')::int`,
    totalPoints: sql<number>`coalesce(sum(${issues.estimate}), 0)::int`,
    donePoints: sql<number>`coalesce(sum(${issues.estimate}) filter (where ${issues.status} = 'Done'), 0)::int`,
  }).from(issues).where(and(...conditions)).groupBy(issues.projectId, issues.milestoneId);
  const result = new Map<string, { project: IssueProgress; milestones: Map<string, IssueProgress> }>();
  for (const row of rows) {
    if (!row.projectId) continue;
    const aggregate = result.get(row.projectId) ?? { project: emptyProgress(), milestones: new Map<string, IssueProgress>() };
    const values = {
      totalIssues: Number(row.totalIssues),
      doneIssues: Number(row.doneIssues),
      totalPoints: Number(row.totalPoints),
      donePoints: Number(row.donePoints),
    };
    aggregate.project.totalIssues += values.totalIssues;
    aggregate.project.doneIssues += values.doneIssues;
    aggregate.project.totalPoints += values.totalPoints;
    aggregate.project.donePoints += values.donePoints;
    if (row.milestoneId) aggregate.milestones.set(row.milestoneId, values);
    result.set(row.projectId, aggregate);
  }
  return result;
}

async function createIssue(access: Access, body: z.infer<typeof issueCreateSchema>) {
  const relationError = await validateIssueRelations(getDb(), access.membership.workspaceId, body);
  if (relationError) return jsonError(relationError, 400);
  const database = getDb();
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM workspaces WHERE id = ${access.membership.workspaceId} FOR UPDATE`);
    const transactionRelationError = await validateIssueRelations(transaction, access.membership.workspaceId, body);
    if (transactionRelationError) return jsonError(transactionRelationError, 400);
    const allocated = await transaction.execute(sql`INSERT INTO issue_number_counters (workspace_id, next_number)
      SELECT ${access.membership.workspaceId}, COALESCE(MAX(issue_number), 0) + 1 FROM issues WHERE workspace_id = ${access.membership.workspaceId}
      ON CONFLICT (workspace_id) DO UPDATE SET next_number = GREATEST(issue_number_counters.next_number + 1, EXCLUDED.next_number)
      RETURNING next_number`);
    const issueNumber = Number(allocated.rows[0]?.next_number);
    const [positionRow] = await transaction.select({ value: sql<number>`coalesce(max(${issues.position}), 0)` }).from(issues)
      .where(and(eq(issues.workspaceId, access.membership.workspaceId), eq(issues.status, body.status ?? "Backlog")));
    const [created] = await transaction.insert(issues).values({
      workspaceId: access.membership.workspaceId,
      issueNumber,
      title: body.title,
      description: body.description ?? "",
      status: body.status ?? "Backlog",
      priority: body.priority ?? "No priority",
      assigneeId: body.assigneeId ?? null,
      creatorId: access.session.user.id,
      dueDate: body.dueDate ?? null,
      estimate: body.estimate ?? null,
      projectId: body.projectId ?? null,
      milestoneId: body.milestoneId ?? null,
      cycleId: body.cycleId ?? null,
      parentIssueId: body.parentIssueId ?? null,
      position: Number(positionRow.value) + 100,
    }).returning();
    if (body.labelIds?.length) await transaction.insert(issueLabels).values(body.labelIds.map((labelId) => ({ issueId: created.id, labelId })));
    await transaction.insert(issueFollowers).values([
      { issueId: created.id, userId: access.session.user.id },
      ...(body.assigneeId ? [{ issueId: created.id, userId: body.assigneeId }] : []),
    ]).onConflictDoNothing();
    await recordIssueActivity(transaction, access.membership.workspaceId, created.id, access.session.user.id, "created", "title", null, created.title);
    if (body.cycleId) {
      const [cycle] = await transaction.select().from(cycles).where(eq(cycles.id, body.cycleId)).limit(1);
      if (cycle) await recordCycleMembership(transaction, access.membership.workspaceId, cycle, created.id, "added", access.session.user.id);
    }
    if (body.parentIssueId) {
      await transaction.update(issues).set({ version: sql`${issues.version} + 1` }).where(eq(issues.id, body.parentIssueId));
      await recordIssueActivity(transaction, access.membership.workspaceId, body.parentIssueId, access.session.user.id, "sub_issue_added", null, null, { issueId: created.id, title: created.title });
    }
    if (body.assigneeId && body.assigneeId !== access.session.user.id) await transaction.insert(notifications).values({
      workspaceId: access.membership.workspaceId, issueId: created.id, actorId: access.session.user.id, userId: body.assigneeId, type: "assigned", payload: { issueNumber },
    });
    const descriptionMentions = await descriptionMentionIds(transaction, access.membership.workspaceId, created.description);
    await notifyMentions(transaction, access.membership.workspaceId, created.id, access.session.user.id, descriptionMentions, { source: "description" });
    const [workspace] = await transaction.select({ issueKeyPrefix: workspaces.issueKeyPrefix }).from(workspaces).where(eq(workspaces.id, access.membership.workspaceId)).limit(1);
    return Response.json({ ...created, identifier: `${workspace.issueKeyPrefix}-${issueNumber}`, labels: body.labelIds ?? [] }, { status: 201 });
  });
}

async function issueList(request: Request, access: Access, issueId?: string) {
  const database = getDb();
  if (issueId) {
    const uuid = uuidSchema.safeParse(issueId);
    let parsedId: string | undefined = uuid.success ? uuid.data : undefined;
    if (!parsedId) {
      const [workspace] = await database.select({ issueKeyPrefix: workspaces.issueKeyPrefix }).from(workspaces)
        .where(eq(workspaces.id, access.membership.workspaceId)).limit(1);
      const match = new RegExp(`^${workspace.issueKeyPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`, "i").exec(issueId);
      if (!match) return invalidId("Issue");
      const [found] = await database.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.workspaceId, access.membership.workspaceId), eq(issues.issueNumber, Number(match[1])))).limit(1);
      parsedId = found?.id;
    }
    if (!parsedId) return jsonError("Issue not found", 404);
    const issue = await issueWithLabels(database, parsedId, access.membership.workspaceId);
    return issue ? Response.json(issue) : jsonError("Issue not found", 404);
  }
  const params = new URL(request.url).searchParams;
  const allowedKeys = new Set(["q", "projectId", "status", "priority", "assigneeId", "labelId", "cycleId", "scope", "archived"]);
  const queryValues: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!allowedKeys.has(key)) return jsonError(`Unknown issue filter: ${key}`, 400);
    if (Object.hasOwn(queryValues, key)) return jsonError(`Issue filter ${key} may only be provided once`, 400);
    queryValues[key] = value;
  }
  const parsedQuery = issueListQuerySchema.safeParse(queryValues);
  if (!parsedQuery.success) {
    const issue = parsedQuery.error.issues[0];
    return jsonError(`${issue.path.join(".")}: ${issue.message}`, 400);
  }
  const { scope, archived, ...filters } = parsedQuery.data;
  if (filters.projectId && filters.projectId !== "none") {
    const [project] = await database.select({ id: projects.id }).from(projects).where(and(eq(projects.id, filters.projectId), eq(projects.workspaceId, access.membership.workspaceId))).limit(1);
    if (!project) return jsonError("Project filter was not found in this workspace", 400);
  }
  if (filters.assigneeId && filters.assigneeId !== "none") {
    const [member] = await database.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.userId, filters.assigneeId), eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true))).limit(1);
    if (!member) return jsonError("Assignee filter must be an active workspace member", 400);
  }
  if (filters.labelId) {
    const [label] = await database.select({ id: labels.id }).from(labels).where(and(eq(labels.id, filters.labelId), eq(labels.workspaceId, access.membership.workspaceId))).limit(1);
    if (!label) return jsonError("Label filter was not found in this workspace", 400);
  }
  if (filters.cycleId && filters.cycleId !== "none") {
    const [cycle] = await database.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, filters.cycleId), eq(cycles.workspaceId, access.membership.workspaceId))).limit(1);
    if (!cycle) return jsonError("Cycle filter was not found in this workspace", 400);
  }
  const conditions = [
    eq(issues.workspaceId, access.membership.workspaceId),
    archived === "true" ? isNotNull(issues.archivedAt) : isNull(issues.archivedAt),
  ];
  if (scope === "backlog") conditions.push(eq(issues.status, "Backlog"));
  if (scope === "mine") conditions.push(eq(issues.assigneeId, access.session.user.id));
  if (filters.projectId) conditions.push(filters.projectId === "none" ? isNull(issues.projectId) : eq(issues.projectId, filters.projectId));
  if (filters.status) conditions.push(eq(issues.status, filters.status));
  if (filters.priority) conditions.push(eq(issues.priority, filters.priority));
  if (filters.assigneeId) conditions.push(filters.assigneeId === "none" ? isNull(issues.assigneeId) : eq(issues.assigneeId, filters.assigneeId));
  if (filters.cycleId) conditions.push(filters.cycleId === "none" ? isNull(issues.cycleId) : eq(issues.cycleId, filters.cycleId));
  if (filters.labelId) conditions.push(exists(database.select({ issueId: issueLabels.issueId }).from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id)).where(and(
      eq(issueLabels.issueId, issues.id),
      eq(labels.id, filters.labelId),
      eq(labels.workspaceId, access.membership.workspaceId),
    ))));
  if (filters.q) {
    const escapedQuery = filters.q.replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escapedQuery}%`;
    conditions.push(or(
      ilike(issues.title, pattern),
      ilike(issues.description, pattern),
      exists(database.select({ id: workspaces.id }).from(workspaces).where(and(
        eq(workspaces.id, access.membership.workspaceId),
        ilike(sql`concat(${workspaces.issueKeyPrefix}, '-', ${issues.issueNumber}::text)`, pattern),
      ))),
    )!);
  }
  const rows = await database.select().from(issues).where(and(...conditions)).orderBy(asc(issues.status), asc(issues.position));
  const blockers = await database.selectDistinct({ issueId: issueRelations.blockedIssueId }).from(issueRelations)
    .innerJoin(issues, eq(issueRelations.blockerIssueId, issues.id))
    .where(and(
      eq(issueRelations.workspaceId, access.membership.workspaceId),
      ne(issues.status, "Done"),
      isNull(issues.archivedAt),
    ));
  const blockedIssueIds = new Set(blockers.map(({ issueId }) => issueId));
  const workspace = access.membership;
  const withLabels = await Promise.all(rows.map(async (issue) => {
    const record = await issueWithLabels(database, issue.id, workspace.workspaceId);
    return record ? { ...record, isBlocked: blockedIssueIds.has(issue.id) } : null;
  }));
  return Response.json({ issues: withLabels.filter(Boolean) });
}

async function updateIssue(request: Request, access: Access, issueId: string) {
  const parsedId = validPathId(issueId, "Issue");
  if (parsedId instanceof Response) return parsedId;
  const parsed = await validateDateMutationAndParse(request, issueUpdateSchema);
  if ("response" in parsed) return parsed.response;
  const { version, labelIds, ...fields } = parsed.data;
  const database = getDb();
  return database.transaction(async (transaction) => {
    await lockWorkspace(transaction, access.membership.workspaceId);
    const [current] = await transaction.select().from(issues).where(and(eq(issues.id, parsedId), eq(issues.workspaceId, access.membership.workspaceId))).for("update").limit(1);
    if (!current) return jsonError("Issue not found", 404);
    if (current.version !== version) return Response.json({ error: "Issue has changed", current: await issueWithLabels(transaction, parsedId, access.membership.workspaceId) }, { status: 409 });
    const relationError = await validateIssueRelations(transaction, access.membership.workspaceId, {
      assigneeId: fields.assigneeId === undefined ? current.assigneeId : fields.assigneeId,
      projectId: fields.projectId === undefined ? current.projectId : fields.projectId,
      milestoneId: fields.milestoneId === undefined ? current.milestoneId : fields.milestoneId,
      cycleId: fields.cycleId,
      parentIssueId: fields.parentIssueId === undefined ? current.parentIssueId : fields.parentIssueId,
      labelIds,
    }, parsedId, { projectId: current.projectId, milestoneId: current.milestoneId });
    if (relationError) return jsonError(relationError, 400);
    if (fields.cycleId !== undefined && fields.cycleId !== current.cycleId && current.cycleId) {
      const [currentCycle] = await transaction.select().from(cycles).where(and(
        eq(cycles.id, current.cycleId), eq(cycles.workspaceId, access.membership.workspaceId),
      )).limit(1);
      if (currentCycle?.status === "Completed") return jsonError("Completed cycles are read-only", 409);
    }
    const changes: Record<string, unknown> = {};
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      const value = fields[key];
      if (value !== undefined && value !== current[key as keyof typeof current]) changes[key] = value;
    }
    const oldLabels = await transaction.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, parsedId));
    const nextLabelIds = labelIds === undefined ? oldLabels.map((row) => row.labelId) : labelIds;
    const labelsChanged = labelIds !== undefined && (nextLabelIds.length !== oldLabels.length || nextLabelIds.some((id) => !oldLabels.some((row) => row.labelId === id)));
    if (!Object.keys(changes).length && !labelsChanged) return jsonError("No issue fields changed", 400);
    const [updated] = await transaction.update(issues).set({ ...changes, version: current.version + 1 })
      .where(and(eq(issues.id, parsedId), eq(issues.workspaceId, access.membership.workspaceId), eq(issues.version, version))).returning();
    if (!updated) return Response.json({ error: "Issue has changed", current: await issueWithLabels(transaction, parsedId, access.membership.workspaceId) }, { status: 409 });
    if (labelsChanged) {
      await transaction.delete(issueLabels).where(eq(issueLabels.issueId, parsedId));
      if (nextLabelIds.length) await transaction.insert(issueLabels).values(nextLabelIds.map((labelId) => ({ issueId: parsedId, labelId })));
    }
    if (changes.cycleId !== undefined) {
      if (current.cycleId) {
        const [previousCycle] = await transaction.select().from(cycles).where(eq(cycles.id, current.cycleId)).limit(1);
        if (previousCycle) await recordCycleMembership(transaction, access.membership.workspaceId, previousCycle, parsedId, "removed", access.session.user.id);
      }
      if (typeof changes.cycleId === "string") {
        const [nextCycle] = await transaction.select().from(cycles).where(eq(cycles.id, changes.cycleId)).limit(1);
        if (nextCycle) await recordCycleMembership(transaction, access.membership.workspaceId, nextCycle, parsedId, "added", access.session.user.id);
      }
    }
    for (const [field, nextValue] of Object.entries(changes)) {
      await recordIssueActivity(transaction, access.membership.workspaceId, parsedId, access.session.user.id, "updated", field, current[field as keyof typeof current], nextValue);
    }
    if (labelsChanged) await recordIssueActivity(transaction, access.membership.workspaceId, parsedId, access.session.user.id, "updated", "labels", oldLabels.map((row) => row.labelId), nextLabelIds);
    if (changes.assigneeId) {
      await transaction.insert(issueFollowers).values({ issueId: parsedId, userId: String(changes.assigneeId) }).onConflictDoNothing();
      if (changes.assigneeId !== access.session.user.id) await transaction.insert(notifications).values({
        workspaceId: access.membership.workspaceId, issueId: parsedId, actorId: access.session.user.id, userId: String(changes.assigneeId), type: "assigned", payload: { issueNumber: current.issueNumber },
      });
    }
    if (typeof changes.description === "string") {
      const descriptionMentions = await descriptionMentionIds(transaction, access.membership.workspaceId, changes.description);
      await notifyMentions(transaction, access.membership.workspaceId, parsedId, access.session.user.id, descriptionMentions, { source: "description" });
    }
    return Response.json(await issueWithLabels(transaction, parsedId, access.membership.workspaceId));
  });
}

async function bulkUpdateIssues(request: Request, access: Access) {
  const parsed = await validateMutationAndParse(request, bulkIssueSchema);
  if ("response" in parsed) return parsed.response;
  const database = getDb();
  const { issues: selectedIssues, action } = parsed.data;
  const selectedIds = selectedIssues.map(({ id }) => id);

  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM workspaces WHERE id = ${access.membership.workspaceId} FOR UPDATE`);
    const currentIssues = await transaction.select().from(issues)
      .where(and(eq(issues.workspaceId, access.membership.workspaceId), inArray(issues.id, selectedIds)))
      .for("update");
    if (currentIssues.length !== selectedIssues.length) return jsonError("One or more issues were not found in this workspace", 404);
    if (action.type === "restore" ? currentIssues.some((issue) => !issue.archivedAt) : currentIssues.some((issue) => issue.archivedAt)) {
      return jsonError(action.type === "restore" ? "Only archived issues can be restored in bulk" : "Archived issues cannot be changed in bulk", 400);
    }
    const versionById = new Map(selectedIssues.map(({ id, version }) => [id, version]));
    if (currentIssues.some((issue) => issue.version !== versionById.get(issue.id))) {
      return jsonError("One or more issues have changed. Refresh the list and select them again.", 409);
    }

    const relationInput = action.type === "assignee"
      ? { assigneeId: action.value }
      : action.type === "project"
        ? { projectId: action.value }
        : action.type === "label-add" || action.type === "label-remove"
          ? { labelIds: [action.labelId] }
          : {};
    const relationError = await validateIssueRelations(transaction, access.membership.workspaceId, relationInput);
    if (relationError) return jsonError(relationError, 400);
    if (action.type === "project" && action.value) {
      const [project] = await transaction.select({ id: projects.id }).from(projects).where(and(
        eq(projects.id, action.value),
        eq(projects.workspaceId, access.membership.workspaceId),
        isNull(projects.archivedAt),
      )).limit(1);
      if (!project) return jsonError("Project must be active and belong to this workspace", 400);
    }
    let milestoneAssignment: { id: string; projectId: string } | null = null;
    if (action.type === "milestone" && action.value) {
      const [milestone] = await transaction.select({ id: milestones.id, projectId: milestones.projectId })
        .from(milestones)
        .innerJoin(projects, eq(milestones.projectId, projects.id))
        .where(and(
          eq(milestones.id, action.value), eq(milestones.workspaceId, access.membership.workspaceId),
          isNull(projects.archivedAt), eq(projects.workspaceId, access.membership.workspaceId),
        )).limit(1);
      if (!milestone) return jsonError("Milestone must belong to an active project in this workspace", 400);
      milestoneAssignment = milestone;
    }

    const milestoneIds = [...new Set(currentIssues.map((issue) => issue.milestoneId).filter((id): id is string => Boolean(id)))];
    const milestoneRows = milestoneIds.length ? await transaction.select({ id: milestones.id, projectId: milestones.projectId }).from(milestones)
      .where(and(eq(milestones.workspaceId, access.membership.workspaceId), inArray(milestones.id, milestoneIds))) : [];
    const milestoneProjectById = new Map(milestoneRows.map((milestone) => [milestone.id, milestone.projectId]));
    const labelLinks = action.type === "label-add" || action.type === "label-remove"
      ? await transaction.select({ issueId: issueLabels.issueId, labelId: issueLabels.labelId }).from(issueLabels).where(inArray(issueLabels.issueId, selectedIds))
      : [];
    const labelsByIssue = new Map<string, Set<string>>();
    for (const link of labelLinks) {
      const issueLabelsForIssue = labelsByIssue.get(link.issueId) ?? new Set<string>();
      issueLabelsForIssue.add(link.labelId);
      labelsByIssue.set(link.issueId, issueLabelsForIssue);
    }

    const updatedIds: string[] = [];
    for (const current of currentIssues) {
      const changes: Partial<typeof issues.$inferInsert> = {};
      let activityField: string | null = null;
      let previousValue: unknown;
      let nextValue: unknown;

      if (action.type === "status" && current.status !== action.value) {
        changes.status = action.value;
        activityField = "status";
        previousValue = current.status;
        nextValue = action.value;
      } else if (action.type === "priority" && current.priority !== action.value) {
        changes.priority = action.value;
        activityField = "priority";
        previousValue = current.priority;
        nextValue = action.value;
      } else if (action.type === "assignee" && current.assigneeId !== action.value) {
        changes.assigneeId = action.value;
        activityField = "assigneeId";
        previousValue = current.assigneeId;
        nextValue = action.value;
      } else if (action.type === "project") {
        const nextMilestoneId = current.milestoneId && milestoneProjectById.get(current.milestoneId) !== action.value ? null : current.milestoneId;
        if (current.projectId !== action.value || current.milestoneId !== nextMilestoneId) {
          changes.projectId = action.value;
          changes.milestoneId = nextMilestoneId;
          activityField = "projectId";
          previousValue = { projectId: current.projectId, milestoneId: current.milestoneId };
          nextValue = { projectId: action.value, milestoneId: nextMilestoneId };
        }
      } else if (action.type === "milestone") {
        const nextProjectId = milestoneAssignment?.projectId ?? current.projectId;
        if (current.projectId !== nextProjectId || current.milestoneId !== action.value) {
          changes.projectId = nextProjectId;
          changes.milestoneId = action.value;
          activityField = "milestoneId";
          previousValue = { projectId: current.projectId, milestoneId: current.milestoneId };
          nextValue = { projectId: nextProjectId, milestoneId: action.value };
        }
      } else if (action.type === "archive") {
        changes.archivedAt = new Date();
        activityField = null;
      } else if (action.type === "restore") {
        changes.archivedAt = null;
        activityField = null;
      } else if (action.type === "label-add" || action.type === "label-remove") {
        const currentLabelIds = labelsByIssue.get(current.id) ?? new Set<string>();
        const hasLabel = currentLabelIds.has(action.labelId);
        const shouldHaveLabel = action.type === "label-add";
        if (hasLabel !== shouldHaveLabel) {
          if (shouldHaveLabel) {
            await transaction.insert(issueLabels).values({ issueId: current.id, labelId: action.labelId });
            currentLabelIds.add(action.labelId);
          } else {
            await transaction.delete(issueLabels).where(and(eq(issueLabels.issueId, current.id), eq(issueLabels.labelId, action.labelId)));
            currentLabelIds.delete(action.labelId);
          }
          labelsByIssue.set(current.id, currentLabelIds);
          activityField = "labels";
          previousValue = [...currentLabelIds].filter((id) => id !== action.labelId);
          nextValue = [...currentLabelIds];
          if (!shouldHaveLabel) {
            previousValue = [...currentLabelIds, action.labelId];
            nextValue = [...currentLabelIds];
          }
        }
      }

      const changed = Object.keys(changes).length > 0 || activityField === "labels";
      if (!changed) continue;
      await transaction.update(issues).set({ ...changes, version: current.version + 1 })
        .where(and(eq(issues.id, current.id), eq(issues.workspaceId, access.membership.workspaceId), eq(issues.version, current.version)));
      updatedIds.push(current.id);

      if (action.type === "archive" || action.type === "restore") {
        await recordIssueActivity(transaction, access.membership.workspaceId, current.id, access.session.user.id, action.type === "archive" ? "archived" : "restored");
      } else {
        await recordIssueActivity(transaction, access.membership.workspaceId, current.id, access.session.user.id, "updated", activityField, previousValue, nextValue);
      }
      if (action.type === "assignee" && action.value && action.value !== current.assigneeId) {
        await transaction.insert(issueFollowers).values({ issueId: current.id, userId: action.value }).onConflictDoNothing();
        if (action.value !== access.session.user.id) await transaction.insert(notifications).values({
          workspaceId: access.membership.workspaceId,
          issueId: current.id,
          actorId: access.session.user.id,
          userId: action.value,
          type: "assigned",
          payload: { issueNumber: current.issueNumber },
        });
      }
    }

    const updatedRecords = await Promise.all(currentIssues.map((issue) => issueWithLabels(transaction, issue.id, access.membership.workspaceId)));
    return Response.json({ issues: updatedRecords.filter(Boolean), updatedCount: updatedIds.length });
  });
}

async function deleteIssue(request: Request, access: Access, issueId: string) {
  const parsedId = validPathId(issueId, "Issue");
  if (parsedId instanceof Response) return parsedId;
  const parsed = await validateMutationAndParse(request, z.object({ version: z.number().int().positive() }).strict());
  if ("response" in parsed) return parsed.response;
  const database = getDb();
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(issues).where(and(eq(issues.id, parsedId), eq(issues.workspaceId, access.membership.workspaceId))).for("update").limit(1);
    if (!current) return jsonError("Issue not found", 404);
    if (current.archivedAt) return jsonError("Issue is already archived", 400);
    if (current.version !== parsed.data.version) return Response.json({ error: "Issue has changed", current: await issueWithLabels(transaction, parsedId, access.membership.workspaceId) }, { status: 409 });
    const [updated] = await transaction.update(issues).set({ archivedAt: new Date(), version: current.version + 1 })
      .where(and(eq(issues.id, parsedId), eq(issues.version, current.version))).returning();
    await recordIssueActivity(transaction, access.membership.workspaceId, parsedId, access.session.user.id, "archived");
    return Response.json(await issueWithLabels(transaction, updated.id, access.membership.workspaceId));
  });
}

async function restoreIssue(request: Request, access: Access, issueId: string) {
  const parsedId = validPathId(issueId, "Issue");
  if (parsedId instanceof Response) return parsedId;
  const parsed = await validateMutationAndParse(request, z.object({ version: z.number().int().positive() }).strict());
  if ("response" in parsed) return parsed.response;
  const database = getDb();
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(issues)
      .where(and(eq(issues.id, parsedId), eq(issues.workspaceId, access.membership.workspaceId))).for("update").limit(1);
    if (!current) return jsonError("Issue not found", 404);
    if (current.version !== parsed.data.version) return Response.json({ error: "Issue has changed", current: await issueWithLabels(transaction, parsedId, access.membership.workspaceId) }, { status: 409 });
    if (!current.archivedAt) return jsonError("Issue is not archived", 400);
    await transaction.update(issues).set({ archivedAt: null, version: current.version + 1 })
      .where(and(eq(issues.id, parsedId), eq(issues.version, current.version)));
    await recordIssueActivity(transaction, access.membership.workspaceId, parsedId, access.session.user.id, "restored");
    return Response.json(await issueWithLabels(transaction, parsedId, access.membership.workspaceId));
  });
}

async function reorderIssue(request: Request, access: Access, issueId: string) {
  const parsedId = validPathId(issueId, "Issue");
  if (parsedId instanceof Response) return parsedId;
  const parsed = await validateMutationAndParse(request, reorderSchema.extend({ version: z.number().int().positive() }).strict());
  if ("response" in parsed) return parsed.response;
  const database = getDb();
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM workspaces WHERE id = ${access.membership.workspaceId} FOR UPDATE`);
    const [current] = await transaction.select().from(issues).where(and(eq(issues.id, parsedId), eq(issues.workspaceId, access.membership.workspaceId))).for("update").limit(1);
    if (!current) return jsonError("Issue not found", 404);
    if (current.version !== parsed.data.version) return Response.json({ error: "Issue has changed", current: await issueWithLabels(transaction, parsedId, access.membership.workspaceId) }, { status: 409 });
    let relative: typeof current | undefined;
    if (parsed.data.relativeIssueId) {
      if (parsed.data.relativeIssueId === parsedId) return jsonError("An issue cannot be moved relative to itself", 400);
      [relative] = await transaction.select().from(issues).where(and(eq(issues.id, parsed.data.relativeIssueId), eq(issues.workspaceId, access.membership.workspaceId))).limit(1);
      if (!relative) return jsonError("Relative issue was not found in this workspace", 404);
      if (relative.status !== parsed.data.status) return jsonError("Relative issue must already be in the requested status", 400);
    }
    const siblings = await transaction.select().from(issues).where(and(eq(issues.workspaceId, access.membership.workspaceId), eq(issues.status, parsed.data.status), ne(issues.id, parsedId))).orderBy(asc(issues.position), asc(issues.createdAt));
    let insertionIndex = parsed.data.placement === "top" ? 0 : siblings.length;
    if (relative) {
      const relativeIndex = siblings.findIndex((issue) => issue.id === relative?.id);
      insertionIndex = relativeIndex + (parsed.data.placement === "after" ? 1 : 0);
    }
    siblings.splice(insertionIndex, 0, current);
    const before = { status: current.status, position: current.position };
    for (let index = 0; index < siblings.length; index += 1) {
      const item = siblings[index];
      const nextPosition = (index + 1) * 100;
      if (item.id === current.id) {
        await transaction.update(issues).set({ status: parsed.data.status, position: nextPosition, version: current.version + 1 })
          .where(and(eq(issues.id, current.id), eq(issues.version, current.version)));
      } else if (item.position !== nextPosition) {
        await transaction.update(issues).set({ position: nextPosition, version: item.version + 1 }).where(eq(issues.id, item.id));
      }
    }
    if (before.status !== parsed.data.status) {
      await recordIssueActivity(transaction, access.membership.workspaceId, current.id, access.session.user.id, "updated", "status", before.status, parsed.data.status);
    } else {
      await recordIssueActivity(transaction, access.membership.workspaceId, current.id, access.session.user.id, "reordered", "position", before, { status: parsed.data.status, position: (insertionIndex + 1) * 100 });
    }
    return Response.json(await issueWithLabels(transaction, current.id, access.membership.workspaceId));
  });
}

async function subIssuesRoute(request: Request, access: Access, parentIssueId: string) {
  const parsedParentId = validPathId(parentIssueId, "Issue");
  if (parsedParentId instanceof Response) return parsedParentId;
  const database = getDb();
  const [parent] = await database.select().from(issues).where(and(eq(issues.id, parsedParentId), eq(issues.workspaceId, access.membership.workspaceId))).limit(1);
  if (!parent) return jsonError("Parent issue not found", 404);
  if (request.method === "GET") {
    const children = await database.select().from(issues).where(and(
      eq(issues.workspaceId, access.membership.workspaceId),
      eq(issues.parentIssueId, parsedParentId),
      isNull(issues.archivedAt),
    )).orderBy(asc(issues.position));
    return Response.json({ issues: children });
  }
  if (request.method !== "POST") return jsonError("Method not allowed", 405);
  const parsed = await validateDateMutationAndParse(request, issueCreateSchema.omit({ parentIssueId: true }).strict());
  if ("response" in parsed) return parsed.response;
  if (parent.parentIssueId) return jsonError("Sub-issues may only be one level deep", 400);
  return createIssue(access, { ...parsed.data, parentIssueId: parsedParentId });
}

async function relationsRoute(request: Request, access: Access, issueId: string, relationId?: string) {
  const parsedIssueId = validPathId(issueId, "Issue");
  if (parsedIssueId instanceof Response) return parsedIssueId;
  const [issue] = await getDb().select().from(issues).where(and(eq(issues.id, parsedIssueId), eq(issues.workspaceId, access.membership.workspaceId))).limit(1);
  if (!issue) return jsonError("Issue not found", 404);
  if (request.method === "GET" && !relationId) {
    const rows = await getDb().select().from(issueRelations).where(and(eq(issueRelations.workspaceId, access.membership.workspaceId), or(eq(issueRelations.blockerIssueId, parsedIssueId), eq(issueRelations.blockedIssueId, parsedIssueId))));
    return Response.json({ relations: rows });
  }
  if (request.method === "POST" && !relationId) {
    const parsed = await validateMutationAndParse(request, relationBodySchema);
    if ("response" in parsed) return parsed.response;
    if (parsed.data.blockerIssueId === parsed.data.blockedIssueId) return jsonError("An issue cannot block itself", 400);
    if (![parsed.data.blockerIssueId, parsed.data.blockedIssueId].includes(parsedIssueId)) return jsonError("Relation must include the issue in this URL", 400);
    const database = getDb();
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT id FROM workspaces WHERE id = ${access.membership.workspaceId} FOR UPDATE`);
      const scopedIssues = await transaction.select({ id: issues.id }).from(issues).where(and(eq(issues.workspaceId, access.membership.workspaceId), inArray(issues.id, [parsed.data.blockerIssueId, parsed.data.blockedIssueId])));
      if (scopedIssues.length !== 2) return jsonError("Both issues must belong to this workspace", 400);
      const existing = await transaction.select({ id: issueRelations.id }).from(issueRelations).where(and(
        eq(issueRelations.workspaceId, access.membership.workspaceId),
        eq(issueRelations.blockerIssueId, parsed.data.blockerIssueId),
        eq(issueRelations.blockedIssueId, parsed.data.blockedIssueId),
      )).limit(1);
      if (existing.length) return jsonError("This blocking relation already exists", 409);
      const path = await transaction.execute(sql`WITH RECURSIVE reachable(issue_id) AS (
        SELECT blocked_issue_id FROM issue_relations WHERE workspace_id = ${access.membership.workspaceId} AND blocker_issue_id = ${parsed.data.blockedIssueId}
        UNION
        SELECT relation.blocked_issue_id FROM issue_relations relation JOIN reachable ON relation.blocker_issue_id = reachable.issue_id
        WHERE relation.workspace_id = ${access.membership.workspaceId}
      ) SELECT issue_id FROM reachable WHERE issue_id = ${parsed.data.blockerIssueId} LIMIT 1`);
      if (path.rows.length) return jsonError("This relation would create a circular dependency", 409);
      const [created] = await transaction.insert(issueRelations).values({ ...parsed.data, workspaceId: access.membership.workspaceId, createdById: access.session.user.id }).returning();
      await transaction.update(issues).set({ version: sql`${issues.version} + 1` }).where(inArray(issues.id, [parsed.data.blockerIssueId, parsed.data.blockedIssueId]));
      await recordIssueActivity(transaction, access.membership.workspaceId, parsed.data.blockerIssueId, access.session.user.id, "blocking_relation_added", null, null, { relationId: created.id, blockedIssueId: parsed.data.blockedIssueId });
      await recordIssueActivity(transaction, access.membership.workspaceId, parsed.data.blockedIssueId, access.session.user.id, "blocking_relation_added", null, null, { relationId: created.id, blockerIssueId: parsed.data.blockerIssueId });
      return Response.json(created, { status: 201 });
    });
  }
  if (request.method === "DELETE" && relationId) {
    const parsedRelationId = validPathId(relationId, "Relation");
    if (parsedRelationId instanceof Response) return parsedRelationId;
    const parsed = await validateMutationAndParse(request, emptyBody);
    if ("response" in parsed) return parsed.response;
    const database = getDb();
    return database.transaction(async (transaction) => {
      const [relation] = await transaction.delete(issueRelations).where(and(eq(issueRelations.id, parsedRelationId), eq(issueRelations.workspaceId, access.membership.workspaceId), or(eq(issueRelations.blockerIssueId, parsedIssueId), eq(issueRelations.blockedIssueId, parsedIssueId)))).returning();
      if (!relation) return jsonError("Blocking relation not found", 404);
      await transaction.update(issues).set({ version: sql`${issues.version} + 1` }).where(inArray(issues.id, [relation.blockerIssueId, relation.blockedIssueId]));
      await recordIssueActivity(transaction, access.membership.workspaceId, relation.blockerIssueId, access.session.user.id, "blocking_relation_removed", null, { blockedIssueId: relation.blockedIssueId }, null);
      await recordIssueActivity(transaction, access.membership.workspaceId, relation.blockedIssueId, access.session.user.id, "blocking_relation_removed", null, { blockerIssueId: relation.blockerIssueId }, null);
      return Response.json({ deleted: true });
    });
  }
  return jsonError("Method not allowed", 405);
}

async function commentsRoute(request: Request, access: Access, issueId: string) {
  const parsedIssueId = validPathId(issueId, "Issue");
  if (parsedIssueId instanceof Response) return parsedIssueId;
  const database = getDb();
  const [issue] = await database.select().from(issues).where(and(eq(issues.id, parsedIssueId), eq(issues.workspaceId, access.membership.workspaceId))).limit(1);
  if (!issue) return jsonError("Issue not found", 404);
  if (request.method === "GET") {
    const rows = await database.select({ comment: comments, authorName: user.name }).from(comments).leftJoin(user, eq(comments.authorId, user.id))
      .where(and(eq(comments.workspaceId, access.membership.workspaceId), eq(comments.issueId, parsedIssueId), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt));
    return Response.json({ comments: rows.map(({ comment, authorName }) => ({ ...comment, authorName })) });
  }
  if (request.method !== "POST") return jsonError("Method not allowed", 405);
  const parsed = await validateMutationAndParse(request, commentBodySchema);
  if ("response" in parsed) return parsed.response;
  const mentions = [...new Set(parsed.data.mentionedUserIds)];
  return database.transaction(async (transaction) => {
    const activeMentions = mentions.length ? await transaction.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true), inArray(memberships.userId, mentions))) : [];
    if (activeMentions.length !== mentions.length) return jsonError("Mentioned members must be active members of this workspace", 400);
    const [created] = await transaction.insert(comments).values({ workspaceId: access.membership.workspaceId, issueId: parsedIssueId, authorId: access.session.user.id, body: parsed.data.body, mentionedUserIds: mentions }).returning();
    await transaction.insert(issueFollowers).values([
      { issueId: parsedIssueId, userId: access.session.user.id },
      ...mentions.map((userId) => ({ issueId: parsedIssueId, userId })),
    ]).onConflictDoNothing();
    await recordIssueActivity(transaction, access.membership.workspaceId, parsedIssueId, access.session.user.id, "commented", null, null, { commentId: created.id });
    await notifyMentions(transaction, access.membership.workspaceId, parsedIssueId, access.session.user.id, mentions, { source: "comment", commentId: created.id });
    return Response.json(created, { status: 201 });
  });
}

async function commentItemRoute(request: Request, access: Access, commentId: string) {
  const parsedCommentId = validPathId(commentId, "Comment");
  if (parsedCommentId instanceof Response) return parsedCommentId;
  if (request.method === "PATCH") {
    const parsed = await validateMutationAndParse(request, commentUpdateSchema);
    if ("response" in parsed) return parsed.response;
    return getDb().transaction(async (transaction) => {
      const [current] = await transaction.select().from(comments).where(and(eq(comments.id, parsedCommentId), eq(comments.workspaceId, access.membership.workspaceId), isNull(comments.deletedAt))).for("update").limit(1);
      if (!current) return jsonError("Comment not found", 404);
      if (current.authorId !== access.session.user.id) return jsonError("Only the comment author can edit it", 403);
      if (current.version !== parsed.data.version) return Response.json({ error: "Comment has changed", current }, { status: 409 });
      const mentions = parsed.data.mentionedUserIds === undefined ? current.mentionedUserIds : [...new Set(parsed.data.mentionedUserIds)];
      const activeMentions = mentions.length ? await transaction.select({ userId: memberships.userId }).from(memberships)
        .where(and(eq(memberships.workspaceId, access.membership.workspaceId), eq(memberships.active, true), inArray(memberships.userId, mentions))) : [];
      if (activeMentions.length !== mentions.length) return jsonError("Mentioned members must be active members of this workspace", 400);
      const [updated] = await transaction.update(comments).set({
        ...(parsed.data.body === undefined ? {} : { body: parsed.data.body }),
        mentionedUserIds: mentions,
        version: current.version + 1,
      }).where(and(eq(comments.id, parsedCommentId), eq(comments.version, current.version))).returning();
      await recordIssueActivity(transaction, access.membership.workspaceId, current.issueId, access.session.user.id, "comment_edited", null, { commentId: current.id }, { commentId: current.id });
      if (mentions.length) await transaction.insert(issueFollowers).values(mentions.map((userId) => ({ issueId: current.issueId, userId }))).onConflictDoNothing();
      const recipients = mentions.filter((memberId) => memberId !== access.session.user.id && !current.mentionedUserIds.includes(memberId));
      if (recipients.length) await transaction.insert(notifications).values(recipients.map((userId) => ({ workspaceId: access.membership.workspaceId, issueId: current.issueId, actorId: access.session.user.id, userId, type: "mentioned", payload: { commentId: current.id } })));
      return Response.json(updated);
    });
  }
  if (request.method === "DELETE") {
    const parsed = await validateMutationAndParse(request, z.object({ version: z.number().int().positive() }).strict());
    if ("response" in parsed) return parsed.response;
    return getDb().transaction(async (transaction) => {
      const [current] = await transaction.select().from(comments).where(and(eq(comments.id, parsedCommentId), eq(comments.workspaceId, access.membership.workspaceId), isNull(comments.deletedAt))).for("update").limit(1);
      if (!current) return jsonError("Comment not found", 404);
      if (current.authorId !== access.session.user.id && access.membership.role !== "Admin") return jsonError("Only the author or an Admin can delete a comment", 403);
      if (current.version !== parsed.data.version) return Response.json({ error: "Comment has changed", current }, { status: 409 });
      await transaction.update(comments).set({ deletedAt: new Date(), version: current.version + 1 }).where(eq(comments.id, parsedCommentId));
      await recordIssueActivity(transaction, access.membership.workspaceId, current.issueId, access.session.user.id, "comment_deleted", null, { commentId: current.id }, null);
      return Response.json({ deleted: true });
    });
  }
  return jsonError("Method not allowed", 405);
}


async function issueFollowRoute(request: Request, access: Access, issueId: string) {
  const parsedId = validPathId(issueId, "Issue");
  if (parsedId instanceof Response) return parsedId;
  const database = getDb();
  const [issue] = await database.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, parsedId), eq(issues.workspaceId, access.membership.workspaceId))).limit(1);
  if (!issue) return jsonError("Issue not found", 404);
  if (request.method === "GET") {
    const followers = await database.select({ userId: issueFollowers.userId }).from(issueFollowers).where(eq(issueFollowers.issueId, parsedId));
    return Response.json({ following: followers.some((follower) => follower.userId === access.session.user.id), followerCount: followers.length });
  }
  if (request.method !== "POST" && request.method !== "DELETE") return jsonError("Method not allowed", 405);
  const parsed = await validateMutationAndParse(request, emptyBody);
  if ("response" in parsed) return parsed.response;
  if (request.method === "POST") {
    await database.insert(issueFollowers).values({ issueId: parsedId, userId: access.session.user.id }).onConflictDoNothing();
  } else {
    await database.delete(issueFollowers).where(and(eq(issueFollowers.issueId, parsedId), eq(issueFollowers.userId, access.session.user.id)));
  }
  const followers = await database.select({ userId: issueFollowers.userId }).from(issueFollowers).where(eq(issueFollowers.issueId, parsedId));
  return Response.json({ following: request.method === "POST", followerCount: followers.length });
}

async function activityRoute(request: Request, access: Access, issueId: string) {
  const parsedIssueId = validPathId(issueId, "Issue");
  if (parsedIssueId instanceof Response) return parsedIssueId;
  const database = getDb();
  const [issue] = await database.select({ id: issues.id }).from(issues).where(and(eq(issues.id, parsedIssueId), eq(issues.workspaceId, access.membership.workspaceId))).limit(1);
  if (!issue) return jsonError("Issue not found", 404);
  if (request.method !== "GET") return jsonError("Method not allowed", 405);
  const rows = await database.select({ entry: activity, actorName: user.name }).from(activity).leftJoin(user, eq(activity.actorId, user.id))
    .where(and(eq(activity.workspaceId, access.membership.workspaceId), eq(activity.issueId, parsedIssueId))).orderBy(desc(activity.createdAt));
  return Response.json({ activity: rows.map(({ entry, actorName }) => ({ ...entry, actorName })) });
}

async function notificationsRoute(request: Request, access: Access, notificationId?: string, action?: string) {
  const database = getDb();
  const workspaceId = access.membership.workspaceId;
  const userId = access.session.user.id;
  if (!notificationId && !action && request.method === "GET") {
    const rows = await database.select({ notification: notifications, issueNumber: issues.issueNumber, issueTitle: issues.title, issueKeyPrefix: workspaces.issueKeyPrefix, actorName: user.name })
      .from(notifications).leftJoin(issues, eq(issues.id, notifications.issueId)).leftJoin(workspaces, eq(workspaces.id, notifications.workspaceId)).leftJoin(user, eq(user.id, notifications.actorId))
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId))).orderBy(desc(notifications.createdAt)).limit(100);
    const [{ count }] = await database.select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Response.json({ notifications: rows.map(({ notification, issueNumber, issueTitle, issueKeyPrefix, actorName }) => ({
      ...notification, actorName, issueTitle, issueIdentifier: issueNumber && issueKeyPrefix ? `${issueKeyPrefix}-${issueNumber}` : null, unreadCount: Number(count),
    })), unreadCount: Number(count) });
  }
  if (!notificationId && action === "unread-count" && request.method === "GET") {
    const [{ count }] = await database.select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Response.json({ unreadCount: Number(count) });
  }
  if (!notificationId && action === "read-all" && request.method === "POST") {
    const parsed = await validateMutationAndParse(request, emptyBody);
    if ("response" in parsed) return parsed.response;
    await database.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Response.json({ updated: true });
  }
  if (notificationId && !action && request.method === "PATCH") {
    const parsedId = validPathId(notificationId, "Notification");
    if (parsedId instanceof Response) return parsedId;
    const parsed = await validateMutationAndParse(request, z.object({ read: z.boolean() }).strict());
    if ("response" in parsed) return parsed.response;
    const [updated] = await database.update(notifications).set({ readAt: parsed.data.read ? new Date() : null }).where(and(
      eq(notifications.id, parsedId), eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId),
    )).returning();
    return updated ? Response.json(updated) : jsonError("Notification not found", 404);
  }
  return jsonError("Method not allowed", 405);
}

export async function trackerApiRoute(request: Request, route: string[]) {
  const access = await accessFor(request);
  if ("response" in access) return access.response;
  if (route[0] === "notifications" && route.length === 1) return notificationsRoute(request, access);
  if (route[0] === "notifications" && route[1] === "unread-count" && route.length === 2) return notificationsRoute(request, access, undefined, "unread-count");
  if (route[0] === "notifications" && route[1] === "read-all" && route.length === 2) return notificationsRoute(request, access, undefined, "read-all");
  if (route[0] === "notifications" && route[1] && route.length === 2) return notificationsRoute(request, access, route[1]);
  if (route[0] === "members" && route.length === 1 && request.method === "GET") {
    return Response.json({ members: await listMembers(access.membership.workspaceId) });
  }
  if (route[0] === "saved-views" && route.length <= 2) return savedViewsRoute(request, access, route[1]);
  if (route[0] === "labels" && route.length <= 2) return labelsRoute(request, access, route[1]);
  if (route[0] === "projects" && route.length <= 2) return projectsRoute(request, access, route[1]);
  if (route[0] === "milestones" && route[1] === "reorder" && route.length === 2 && request.method === "POST") return reorderMilestones(request, access);
  if (route[0] === "milestones" && route.length <= 2) return milestonesRoute(request, access, route[1]);
  if (route[0] === "cycles" && route.length === 1) return cyclesRoute(request, access);
  if (route[0] === "cycles" && route[1] && route.length === 2) return cycleRoute(request, access, route[1]);
  if (route[0] === "cycles" && route[1] && route[2] && route.length === 3) return cycleRoute(request, access, route[1], route[2]);
  if (route[0] === "issues" && route[1] === "csv" && route.length === 3) {
    if (route[2] === "export" && request.method === "GET") return exportIssuesCsv(request, access);
    if (route[2] === "preview" && request.method === "POST") return importIssuesCsv(request, access, true);
    if (route[2] === "import" && request.method === "POST") return importIssuesCsv(request, access, false);
    return jsonError("Method not allowed", 405);
  }
  if (route[0] === "issues" && route.length === 1) {
    if (request.method === "GET") return issueList(request, access);
    if (request.method === "POST") {
      const parsed = await validateDateMutationAndParse(request, issueCreateSchema);
      if ("response" in parsed) return parsed.response;
      return createIssue(access, parsed.data);
    }
  }
  if (route[0] === "issues" && route[1] === "bulk" && route.length === 2 && request.method === "POST") return bulkUpdateIssues(request, access);
  if (route[0] === "issues" && route[1] && route[2] === "restore" && route.length === 3 && request.method === "POST") return restoreIssue(request, access, route[1]);
  if (route[0] === "issues" && route[1] && route.length === 2) {
    if (request.method === "GET") return issueList(request, access, route[1]);
    if (request.method === "PATCH") return updateIssue(request, access, route[1]);
    if (request.method === "DELETE") return deleteIssue(request, access, route[1]);
  }
  if (route[0] === "issues" && route[1] && route[2] === "position" && route.length === 3 && request.method === "PATCH") return reorderIssue(request, access, route[1]);
  if (route[0] === "issues" && route[1] && route[2] === "sub-issues" && route.length === 3) return subIssuesRoute(request, access, route[1]);
  if (route[0] === "issues" && route[1] && route[2] === "relations" && route.length === 3) return relationsRoute(request, access, route[1]);
  if (route[0] === "issues" && route[1] && route[2] === "relations" && route[3] && route.length === 4) return relationsRoute(request, access, route[1], route[3]);
  if (route[0] === "issues" && route[1] && route[2] === "comments" && route.length === 3) return commentsRoute(request, access, route[1]);
  if (route[0] === "comments" && route[1] && route.length === 2) return commentItemRoute(request, access, route[1]);
  if (route[0] === "issues" && route[1] && route[2] === "follow" && route.length === 3) return issueFollowRoute(request, access, route[1]);
  if (route[0] === "issues" && route[1] && route[2] === "activity" && route.length === 3) return activityRoute(request, access, route[1]);
  return jsonError("Route not found", 404);
}
