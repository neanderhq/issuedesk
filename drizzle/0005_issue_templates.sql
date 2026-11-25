CREATE TABLE "issue_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"title" varchar(200) DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" "issue_priority" DEFAULT 'No priority' NOT NULL,
	"project_id" uuid,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_templates_workspace_name_unique" ON "issue_templates" USING btree ("workspace_id",lower("name"));
--> statement-breakpoint
CREATE TRIGGER "issue_templates_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "issue_templates" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
