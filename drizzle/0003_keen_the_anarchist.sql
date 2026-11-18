CREATE TABLE "workspace_change_cursors" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_change_cursors" ADD CONSTRAINT "workspace_change_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "public"."bump_workspace_change_cursor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	target_workspace_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_workspace_id := OLD."workspace_id";
	ELSE
		target_workspace_id := NEW."workspace_id";
	END IF;
	INSERT INTO "public"."workspace_change_cursors" ("workspace_id", "cursor", "updated_at")
	VALUES (target_workspace_id, 1, now())
	ON CONFLICT ("workspace_id") DO UPDATE
	SET "cursor" = "workspace_change_cursors"."cursor" + 1, "updated_at" = now();
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."bump_issue_change_cursor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	target_issue_id uuid;
	target_workspace_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_issue_id := OLD."issue_id";
	ELSE
		target_issue_id := NEW."issue_id";
	END IF;
	SELECT "workspace_id" INTO target_workspace_id FROM "public"."issues" WHERE "id" = target_issue_id;
	IF target_workspace_id IS NOT NULL THEN
		INSERT INTO "public"."workspace_change_cursors" ("workspace_id", "cursor", "updated_at")
		VALUES (target_workspace_id, 1, now())
		ON CONFLICT ("workspace_id") DO UPDATE
		SET "cursor" = "workspace_change_cursors"."cursor" + 1, "updated_at" = now();
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issues_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."issues" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "comments_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."comments" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "projects_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "milestones_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."milestones" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "cycles_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."cycles" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "labels_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."labels" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "memberships_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "notifications_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "issue_labels_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."issue_labels" FOR EACH ROW EXECUTE FUNCTION "public"."bump_issue_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "issue_relations_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."issue_relations" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "issue_followers_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."issue_followers" FOR EACH ROW EXECUTE FUNCTION "public"."bump_issue_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "activity_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."activity" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
--> statement-breakpoint
CREATE TRIGGER "attachments_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON "public"."attachments" FOR EACH ROW EXECUTE FUNCTION "public"."bump_workspace_change_cursor"();
