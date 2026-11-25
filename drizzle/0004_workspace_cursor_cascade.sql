-- Cascaded child deletes must not recreate a cursor after its workspace is gone.
CREATE OR REPLACE FUNCTION "public"."bump_workspace_change_cursor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	target_workspace_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_workspace_id := OLD."workspace_id";
	ELSE
		target_workspace_id := NEW."workspace_id";
	END IF;
	INSERT INTO "public"."workspace_change_cursors" ("workspace_id", "cursor", "updated_at")
	SELECT "id", 1, now() FROM "public"."workspaces" WHERE "id" = target_workspace_id
	ON CONFLICT ("workspace_id") DO UPDATE
	SET "cursor" = "workspace_change_cursors"."cursor" + 1, "updated_at" = now();
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."bump_issue_change_cursor"() RETURNS trigger LANGUAGE plpgsql AS $$
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
	INSERT INTO "public"."workspace_change_cursors" ("workspace_id", "cursor", "updated_at")
	SELECT "id", 1, now() FROM "public"."workspaces" WHERE "id" = target_workspace_id
	ON CONFLICT ("workspace_id") DO UPDATE
	SET "cursor" = "workspace_change_cursors"."cursor" + 1, "updated_at" = now();
	RETURN NULL;
END;
$$;
