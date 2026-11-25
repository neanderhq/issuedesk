CREATE TYPE "public"."project_health" AS ENUM('On track', 'At risk', 'Off track');--> statement-breakpoint
CREATE TABLE "project_update_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"update_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"health" "project_health" NOT NULL,
	"body" text NOT NULL,
	"actor_id" text,
	"actor_name" varchar(120) NOT NULL,
	"action" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"author_id" text,
	"author_name" varchar(120) NOT NULL,
	"health" "project_health" NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_update_revisions" ADD CONSTRAINT "project_update_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_update_revisions" ADD CONSTRAINT "project_update_revisions_update_id_project_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."project_updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_update_revisions" ADD CONSTRAINT "project_update_revisions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_update_revisions_version_unique" ON "project_update_revisions" USING btree ("update_id","version");--> statement-breakpoint
CREATE INDEX "project_updates_workspace_project_created_idx" ON "project_updates" USING btree ("workspace_id","project_id","created_at");
--> statement-breakpoint
CREATE TRIGGER "project_updates_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "project_updates" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
