CREATE TABLE "github_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository" varchar(200) NOT NULL,
	"status" varchar(30) NOT NULL,
	"reason" text,
	"connected_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"body_hash" varchar(64) NOT NULL,
	"event" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"provider_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"url" varchar(500) NOT NULL,
	"state" varchar(20) NOT NULL,
	"base_branch" varchar(255) NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"complete_on_merge" boolean DEFAULT false NOT NULL,
	"completion_applied_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"unlinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_connected_by_id_user_id_fk" FOREIGN KEY ("connected_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_deliveries" ADD CONSTRAINT "github_deliveries_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_workspace_unique" ON "github_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_installation_repository_unique" ON "github_connections" USING btree ("installation_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_deliveries_connection_delivery_unique" ON "github_deliveries" USING btree ("connection_id","delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_pull_requests_active_issue_unique" ON "github_pull_requests" USING btree ("issue_id") WHERE "github_pull_requests"."unlinked_at" is null;--> statement-breakpoint
CREATE INDEX "github_pull_requests_provider_idx" ON "github_pull_requests" USING btree ("connection_id","provider_id");
--> statement-breakpoint
CREATE TRIGGER github_connections_workspace_cursor AFTER INSERT OR UPDATE OR DELETE ON github_connections FOR EACH ROW EXECUTE FUNCTION bump_workspace_change_cursor();
--> statement-breakpoint
CREATE TRIGGER github_pull_requests_workspace_cursor AFTER INSERT OR UPDATE OR DELETE ON github_pull_requests FOR EACH ROW EXECUTE FUNCTION bump_workspace_change_cursor();
