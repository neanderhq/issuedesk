CREATE TYPE "public"."cycle_status" AS ENUM('Upcoming', 'Active', 'Completed');--> statement-breakpoint
CREATE TYPE "public"."issue_priority" AS ENUM('No priority', 'Urgent', 'High', 'Medium', 'Low');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('Backlog', 'Todo', 'In Progress', 'In Review', 'Done');--> statement-breakpoint
CREATE TYPE "public"."saved_view_layout" AS ENUM('List', 'Board');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_id" text,
	"action" varchar(80) NOT NULL,
	"field" varchar(80),
	"previous_value" jsonb,
	"next_value" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"uploaded_by_id" text,
	"file_name" varchar(255) NOT NULL,
	"content_type" varchar(160) NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_size_range_check" CHECK ("attachments"."size" > 0 and "attachments"."size" <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"mentioned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cycle_membership_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_scope_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"goal" text,
	"status" "cycle_status" DEFAULT 'Upcoming' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycles_date_order_check" CHECK ("cycles"."start_date" <= "cycles"."end_date")
);
--> statement-breakpoint
CREATE TABLE "issue_followers" (
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_labels" (
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_number_counters" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_number_counters_next_number_check" CHECK ("issue_number_counters"."next_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "issue_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"blocker_issue_id" uuid NOT NULL,
	"blocked_issue_id" uuid NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_relations_not_self_check" CHECK ("issue_relations"."blocker_issue_id" <> "issue_relations"."blocked_issue_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_number" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "issue_status" DEFAULT 'Backlog' NOT NULL,
	"priority" "issue_priority" DEFAULT 'No priority' NOT NULL,
	"assignee_id" text,
	"creator_id" text,
	"due_date" date,
	"estimate" integer,
	"project_id" uuid,
	"milestone_id" uuid,
	"cycle_id" uuid,
	"parent_issue_id" uuid,
	"position" double precision DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_number_positive_check" CHECK ("issues"."issue_number" > 0),
	CONSTRAINT "issues_estimate_range_check" CHECK ("issues"."estimate" is null or ("issues"."estimate" >= 0 and "issues"."estimate" <= 100)),
	CONSTRAINT "issues_not_own_parent_check" CHECK ("issues"."parent_issue_id" is null or "issues"."parent_issue_id" <> "issues"."id")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"color" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"target_date" date,
	"position" double precision DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" uuid,
	"actor_id" text,
	"type" varchar(40) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"lead_user_id" text,
	"start_date" date,
	"target_date" date,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_date_order_check" CHECK ("projects"."start_date" is null or "projects"."target_date" is null or "projects"."start_date" <= "projects"."target_date")
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text,
	"name" varchar(120) NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"layout" "saved_view_layout" DEFAULT 'List' NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_seed_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seed_key" varchar(80) NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_scope_events" ADD CONSTRAINT "cycle_scope_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_scope_events" ADD CONSTRAINT "cycle_scope_events_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_scope_events" ADD CONSTRAINT "cycle_scope_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_scope_events" ADD CONSTRAINT "cycle_scope_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_followers" ADD CONSTRAINT "issue_followers_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_followers" ADD CONSTRAINT "issue_followers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_number_counters" ADD CONSTRAINT "issue_number_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_blocker_issue_id_issues_id_fk" FOREIGN KEY ("blocker_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_blocked_issue_id_issues_id_fk" FOREIGN KEY ("blocked_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_user_id_user_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_seed_state" ADD CONSTRAINT "workspace_seed_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_workspace_issue_created_idx" ON "activity" USING btree ("workspace_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "activity" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "attachments_workspace_issue_created_idx" ON "attachments" USING btree ("workspace_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_workspace_issue_created_idx" ON "comments" USING btree ("workspace_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "cycle_membership_history_workspace_cycle_idx" ON "cycle_membership_history" USING btree ("workspace_id","cycle_id","created_at");--> statement-breakpoint
CREATE INDEX "cycle_membership_history_issue_idx" ON "cycle_membership_history" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "cycle_scope_events_workspace_cycle_idx" ON "cycle_scope_events" USING btree ("workspace_id","cycle_id","created_at");--> statement-breakpoint
CREATE INDEX "cycle_scope_events_issue_idx" ON "cycle_scope_events" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_workspace_name_unique" ON "cycles" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_one_active_per_workspace_unique" ON "cycles" USING btree ("workspace_id") WHERE "cycles"."status" = 'Active';--> statement-breakpoint
CREATE INDEX "cycles_workspace_status_dates_idx" ON "cycles" USING btree ("workspace_id","status","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_followers_issue_user_unique" ON "issue_followers" USING btree ("issue_id","user_id");--> statement-breakpoint
CREATE INDEX "issue_followers_user_idx" ON "issue_followers" USING btree ("user_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_labels_issue_label_unique" ON "issue_labels" USING btree ("issue_id","label_id");--> statement-breakpoint
CREATE INDEX "issue_labels_label_idx" ON "issue_labels" USING btree ("label_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_relations_blocker_blocked_unique" ON "issue_relations" USING btree ("blocker_issue_id","blocked_issue_id");--> statement-breakpoint
CREATE INDEX "issue_relations_workspace_blocker_idx" ON "issue_relations" USING btree ("workspace_id","blocker_issue_id");--> statement-breakpoint
CREATE INDEX "issue_relations_workspace_blocked_idx" ON "issue_relations" USING btree ("workspace_id","blocked_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_workspace_number_unique" ON "issues" USING btree ("workspace_id","issue_number");--> statement-breakpoint
CREATE INDEX "issues_workspace_status_position_idx" ON "issues" USING btree ("workspace_id","status","position");--> statement-breakpoint
CREATE INDEX "issues_workspace_project_idx" ON "issues" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "issues_workspace_cycle_idx" ON "issues" USING btree ("workspace_id","cycle_id");--> statement-breakpoint
CREATE INDEX "issues_workspace_assignee_idx" ON "issues" USING btree ("workspace_id","assignee_id");--> statement-breakpoint
CREATE INDEX "issues_parent_idx" ON "issues" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX "issues_milestone_idx" ON "issues" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_workspace_name_unique" ON "labels" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "labels_workspace_idx" ON "labels" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_name_unique" ON "milestones" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "milestones_workspace_project_position_idx" ON "milestones" USING btree ("workspace_id","project_id","position");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("workspace_id","user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_issue_idx" ON "notifications" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_name_unique" ON "projects" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "projects_workspace_archived_idx" ON "projects" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "projects_lead_user_idx" ON "projects" USING btree ("lead_user_id");--> statement-breakpoint
CREATE INDEX "saved_views_workspace_shared_idx" ON "saved_views" USING btree ("workspace_id","shared","name");--> statement-breakpoint
CREATE INDEX "saved_views_owner_idx" ON "saved_views" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_seed_state_workspace_key_unique" ON "workspace_seed_state" USING btree ("workspace_id","seed_key");