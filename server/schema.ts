import { relations, sql } from "drizzle-orm";
import { bigint, boolean, check, customType, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export * from "./auth-schema";

const binary = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const todos = pgTable("todos", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  done: boolean("done").default(false).notNull(),
});

export const workspaceRole = pgEnum("workspace_role", ["Admin", "Member"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  issueKeyPrefix: varchar("issue_key_prefix", { length: 12 }).default("TT").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memberships = pgTable("memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: workspaceRole("role").default("Member").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("memberships_workspace_user_unique").on(table.workspaceId, table.userId),
  index("memberships_user_active_idx").on(table.userId, table.active),
]);

export const workspaceChangeCursors = pgTable("workspace_change_cursors", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  cursor: bigint("cursor", { mode: "number" }).default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const invitations = pgTable("invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  role: workspaceRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [index("invitations_workspace_email_idx").on(table.workspaceId, table.email)]);

export const passwordResetRequests = pgTable("password_reset_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
}, (table) => [index("password_reset_requests_pending_idx").on(table.email, table.fulfilledAt)]);

export const loginRateLimits = pgTable("login_rate_limits", {
  ipHash: varchar("ip_hash", { length: 64 }).primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").default(1).notNull(),
});

export const issueStatus = pgEnum("issue_status", ["Backlog", "Todo", "In Progress", "In Review", "Done"]);
export const issuePriority = pgEnum("issue_priority", ["No priority", "Urgent", "High", "Medium", "Low"]);
export const cycleStatus = pgEnum("cycle_status", ["Upcoming", "Active", "Completed"]);
export const savedViewLayout = pgEnum("saved_view_layout", ["List", "Board"]);

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  leadUserId: text("lead_user_id").references(() => user.id, { onDelete: "set null" }),
  startDate: date("start_date"),
  targetDate: date("target_date"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("projects_workspace_name_unique").on(table.workspaceId, table.name),
  index("projects_workspace_archived_idx").on(table.workspaceId, table.archivedAt),
  index("projects_lead_user_idx").on(table.leadUserId),
  check("projects_date_order_check", sql`${table.startDate} is null or ${table.targetDate} is null or ${table.startDate} <= ${table.targetDate}`),
]);

export const milestones = pgTable("milestones", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  targetDate: date("target_date"),
  position: doublePrecision("position").default(0).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("milestones_project_name_unique").on(table.projectId, table.name),
  index("milestones_workspace_project_position_idx").on(table.workspaceId, table.projectId, table.position),
]);

export const labels = pgTable("labels", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  color: varchar("color", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("labels_workspace_name_unique").on(table.workspaceId, table.name),
  index("labels_workspace_idx").on(table.workspaceId),
]);

export const issueNumberCounters = pgTable("issue_number_counters", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  nextNumber: integer("next_number").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [check("issue_number_counters_next_number_check", sql`${table.nextNumber} > 0`)]);

export const cycles = pgTable("cycles", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  goal: text("goal"),
  status: cycleStatus("status").default("Upcoming").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("cycles_workspace_name_unique").on(table.workspaceId, table.name),
  uniqueIndex("cycles_one_active_per_workspace_unique").on(table.workspaceId).where(sql`${table.status} = 'Active'`),
  index("cycles_workspace_status_dates_idx").on(table.workspaceId, table.status, table.startDate, table.endDate),
  check("cycles_date_order_check", sql`${table.startDate} <= ${table.endDate}`),
]);

export const issues = pgTable("issues", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  issueNumber: integer("issue_number").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description").default("").notNull(),
  status: issueStatus("status").default("Backlog").notNull(),
  priority: issuePriority("priority").default("No priority").notNull(),
  assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
  creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  estimate: integer("estimate"),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
  cycleId: uuid("cycle_id").references(() => cycles.id, { onDelete: "set null" }),
  parentIssueId: uuid("parent_issue_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
  position: doublePrecision("position").default(0).notNull(),
  version: integer("version").default(1).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("issues_workspace_number_unique").on(table.workspaceId, table.issueNumber),
  index("issues_workspace_status_position_idx").on(table.workspaceId, table.status, table.position),
  index("issues_workspace_project_idx").on(table.workspaceId, table.projectId),
  index("issues_workspace_cycle_idx").on(table.workspaceId, table.cycleId),
  index("issues_workspace_assignee_idx").on(table.workspaceId, table.assigneeId),
  index("issues_parent_idx").on(table.parentIssueId),
  index("issues_milestone_idx").on(table.milestoneId),
  check("issues_number_positive_check", sql`${table.issueNumber} > 0`),
  check("issues_estimate_range_check", sql`${table.estimate} is null or (${table.estimate} >= 0 and ${table.estimate} <= 100)`),
  check("issues_not_own_parent_check", sql`${table.parentIssueId} is null or ${table.parentIssueId} <> ${table.id}`),
]);

export const issueLabels = pgTable("issue_labels", {
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("issue_labels_issue_label_unique").on(table.issueId, table.labelId),
  index("issue_labels_label_idx").on(table.labelId, table.issueId),
]);

export const issueRelations = pgTable("issue_relations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  blockerIssueId: uuid("blocker_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  blockedIssueId: uuid("blocked_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("issue_relations_blocker_blocked_unique").on(table.blockerIssueId, table.blockedIssueId),
  index("issue_relations_workspace_blocker_idx").on(table.workspaceId, table.blockerIssueId),
  index("issue_relations_workspace_blocked_idx").on(table.workspaceId, table.blockedIssueId),
  check("issue_relations_not_self_check", sql`${table.blockerIssueId} <> ${table.blockedIssueId}`),
]);

export const comments = pgTable("comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  mentionedUserIds: jsonb("mentioned_user_ids").$type<string[]>().default([]).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("comments_workspace_issue_created_idx").on(table.workspaceId, table.issueId, table.createdAt),
  index("comments_author_idx").on(table.authorId),
]);

export const activity = pgTable("activity", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  action: varchar("action", { length: 80 }).notNull(),
  field: varchar("field", { length: 80 }),
  previousValue: jsonb("previous_value"),
  nextValue: jsonb("next_value"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("activity_workspace_issue_created_idx").on(table.workspaceId, table.issueId, table.createdAt),
  index("activity_actor_idx").on(table.actorId),
]);

export const issueFollowers = pgTable("issue_followers", {
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("issue_followers_issue_user_unique").on(table.issueId, table.userId),
  index("issue_followers_user_idx").on(table.userId, table.issueId),
]);

export const cycleMembershipHistory = pgTable("cycle_membership_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cycleId: uuid("cycle_id").notNull().references(() => cycles.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  action: varchar("action", { length: 32 }).notNull(),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("cycle_membership_history_workspace_cycle_idx").on(table.workspaceId, table.cycleId, table.createdAt),
  index("cycle_membership_history_issue_idx").on(table.issueId, table.createdAt),
]);

export const cycleScopeEvents = pgTable("cycle_scope_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cycleId: uuid("cycle_id").notNull().references(() => cycles.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  action: varchar("action", { length: 32 }).notNull(),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("cycle_scope_events_workspace_cycle_idx").on(table.workspaceId, table.cycleId, table.createdAt),
  index("cycle_scope_events_issue_idx").on(table.issueId, table.createdAt),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  type: varchar("type", { length: 40 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("notifications_user_unread_idx").on(table.workspaceId, table.userId, table.readAt, table.createdAt),
  index("notifications_issue_idx").on(table.issueId),
]);

export const savedViews = pgTable("saved_views", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
  name: varchar("name", { length: 120 }).notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}).notNull(),
  layout: savedViewLayout("layout").default("List").notNull(),
  shared: boolean("shared").default(false).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("saved_views_workspace_shared_idx").on(table.workspaceId, table.shared, table.name),
  index("saved_views_owner_idx").on(table.ownerId),
]);

export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  uploadedById: text("uploaded_by_id").references(() => user.id, { onDelete: "set null" }),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 160 }).notNull(),
  size: integer("size").notNull(),
  bytes: binary("bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("attachments_workspace_issue_created_idx").on(table.workspaceId, table.issueId, table.createdAt),
  check("attachments_size_range_check", sql`${table.size} > 0 and ${table.size} <= 5242880`),
]);

export const workspaceSeedState = pgTable("workspace_seed_state", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  seedKey: varchar("seed_key", { length: 80 }).notNull(),
  seededAt: timestamp("seeded_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("workspace_seed_state_workspace_key_unique").on(table.workspaceId, table.seedKey),
]);

export const projectRelations = relations(projects, ({ many, one }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  lead: one(user, { fields: [projects.leadUserId], references: [user.id] }),
  milestones: many(milestones),
  issues: many(issues),
}));

export const milestoneRelations = relations(milestones, ({ many, one }) => ({
  workspace: one(workspaces, { fields: [milestones.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [milestones.projectId], references: [projects.id] }),
  issues: many(issues),
}));

export const labelRelations = relations(labels, ({ many, one }) => ({
  workspace: one(workspaces, { fields: [labels.workspaceId], references: [workspaces.id] }),
  issueLabels: many(issueLabels),
}));

export const cycleRelations = relations(cycles, ({ many, one }) => ({
  workspace: one(workspaces, { fields: [cycles.workspaceId], references: [workspaces.id] }),
  issues: many(issues),
  membershipHistory: many(cycleMembershipHistory),
  scopeEvents: many(cycleScopeEvents),
}));

export const issueRelationsMapping = relations(issues, ({ many, one }) => ({
  workspace: one(workspaces, { fields: [issues.workspaceId], references: [workspaces.id] }),
  assignee: one(user, { fields: [issues.assigneeId], references: [user.id], relationName: "issueAssignee" }),
  creator: one(user, { fields: [issues.creatorId], references: [user.id], relationName: "issueCreator" }),
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  milestone: one(milestones, { fields: [issues.milestoneId], references: [milestones.id] }),
  cycle: one(cycles, { fields: [issues.cycleId], references: [cycles.id] }),
  parent: one(issues, { fields: [issues.parentIssueId], references: [issues.id], relationName: "issueParent" }),
  children: many(issues, { relationName: "issueParent" }),
  labels: many(issueLabels),
  blockers: many(issueRelations, { relationName: "issueBlockers" }),
  blockedIssues: many(issueRelations, { relationName: "issueBlocked" }),
  comments: many(comments),
  activity: many(activity),
  followers: many(issueFollowers),
  attachments: many(attachments),
}));

export const issueLabelRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, { fields: [issueLabels.issueId], references: [issues.id] }),
  label: one(labels, { fields: [issueLabels.labelId], references: [labels.id] }),
}));

export const issueBlockingRelations = relations(issueRelations, ({ one }) => ({
  blocker: one(issues, { fields: [issueRelations.blockerIssueId], references: [issues.id], relationName: "issueBlockers" }),
  blocked: one(issues, { fields: [issueRelations.blockedIssueId], references: [issues.id], relationName: "issueBlocked" }),
}));

export const commentRelations = relations(comments, ({ one }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(user, { fields: [comments.authorId], references: [user.id] }),
}));

export const activityRelations = relations(activity, ({ one }) => ({
  issue: one(issues, { fields: [activity.issueId], references: [issues.id] }),
  actor: one(user, { fields: [activity.actorId], references: [user.id] }),
}));

export const followerRelations = relations(issueFollowers, ({ one }) => ({
  issue: one(issues, { fields: [issueFollowers.issueId], references: [issues.id] }),
  user: one(user, { fields: [issueFollowers.userId], references: [user.id] }),
}));

// Defaults deliberately keep deleted references so application can report/repair them.
export const issueTemplates = pgTable("issue_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  title: varchar("title", { length: 200 }).default("").notNull(),
  description: text("description").default("").notNull(),
  priority: issuePriority("priority").default("No priority").notNull(),
  projectId: uuid("project_id"),
  labelIds: jsonb("label_ids").$type<string[]>().default([]).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("issue_templates_workspace_name_unique").on(table.workspaceId, sql`lower(${table.name})`)]);

export const projectHealth = pgEnum("project_health", ["On track", "At risk", "Off track"]);
export const projectUpdates = pgTable("project_updates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
  authorName: varchar("author_name", { length: 120 }).notNull(),
  health: projectHealth("health").notNull(), body: text("body").notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
}, (table) => [index("project_updates_workspace_project_created_idx").on(table.workspaceId, table.projectId, table.createdAt)]);
export const projectUpdateRevisions = pgTable("project_update_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  updateId: uuid("update_id").notNull().references(() => projectUpdates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  health: projectHealth("health").notNull(), body: text("body").notNull(),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  actorName: varchar("actor_name", { length: 120 }).notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("project_update_revisions_version_unique").on(table.updateId, table.version)]);

export const githubConnections = pgTable("github_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  repository: varchar("repository", { length: 200 }).notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  reason: text("reason"),
  connectedById: text("connected_by_id").references(() => user.id, { onDelete: "set null" }),
  version: integer("version").default(1).notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("github_connections_workspace_unique").on(table.workspaceId),uniqueIndex("github_connections_installation_repository_unique").on(table.installationId,table.repositoryId)]);
export const githubPullRequests = pgTable("github_pull_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => githubConnections.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  providerId: bigint("provider_id", { mode: "number" }).notNull(),
  number: integer("number").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),
  state: varchar("state", { length: 20 }).notNull(),
  baseBranch: varchar("base_branch", { length: 255 }).notNull(),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }).notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),
  completeOnMerge: boolean("complete_on_merge").default(false).notNull(),
  completionAppliedAt: timestamp("completion_applied_at", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table=>[uniqueIndex("github_pull_requests_active_issue_unique").on(table.issueId).where(sql`${table.unlinkedAt} is null`),index("github_pull_requests_provider_idx").on(table.connectionId,table.providerId)]);
export const githubDeliveries=pgTable("github_deliveries", {
 id:uuid("id").defaultRandom().primaryKey(),
 connectionId:uuid("connection_id").notNull().references(()=>githubConnections.id,{onDelete:"cascade"}),
 deliveryId:uuid("delivery_id").notNull(),bodyHash:varchar("body_hash",{length:64}).notNull(),event:varchar("event",{length:80}).notNull(),
 createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),
},table=>[uniqueIndex("github_deliveries_connection_delivery_unique").on(table.connectionId,table.deliveryId)]);
