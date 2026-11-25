import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { jsonError, requireWorkspaceAccess, validateMutationAndParse } from "./http";
import { issueTemplates, labels, projects } from "./schema";
import { multilineTextInput, textInput } from "./validation";

type Access = Extract<Awaited<ReturnType<typeof requireWorkspaceAccess>>, { membership: unknown }>;
const fields = z.object({
  name: textInput(120).min(1, "Template name is required"),
  title: textInput(200), description: multilineTextInput(20000),
  priority: z.enum(["No priority", "Urgent", "High", "Medium", "Low"]),
  projectId: z.uuid().nullable(),
  labelIds: z.array(z.uuid()).max(30).refine((ids) => new Set(ids).size === ids.length, "Labels must be unique"),
}).strict();
const version = z.object({ version: z.number().int().positive() }).strict();
const update = fields.extend({ version: z.number().int().positive() });

async function invalidDefaults(row: Pick<typeof issueTemplates.$inferSelect, "projectId" | "labelIds">, workspaceId: string) {
  if (row.projectId) {
    const [project] = await getDb().select({ id: projects.id }).from(projects).where(and(eq(projects.id, row.projectId), eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)));
    if (!project) return "The template project is unavailable. An Admin must repair its defaults.";
  }
  if (row.labelIds.length) {
    const found = await getDb().select({ id: labels.id }).from(labels).where(and(eq(labels.workspaceId, workspaceId), inArray(labels.id, row.labelIds)));
    if (found.length !== row.labelIds.length) return "A template label is unavailable. An Admin must repair its defaults.";
  }
  return null;
}

export async function issueTemplatesRoute(request: Request, access: Access, path: string[]) {
  const db = getDb(); const workspaceId = access.membership.workspaceId;
  const id = path[0];
  if (path.length > 2 || (path[1] && path[1] !== "apply")) return jsonError("Route not found", 404);
  if (id && !z.uuid().safeParse(id).success) return jsonError("Template id is invalid", 400);
  const where = id ? and(eq(issueTemplates.id, id), eq(issueTemplates.workspaceId, workspaceId)) : eq(issueTemplates.workspaceId, workspaceId);
  if (request.method === "GET") {
    if (!id) {
      const rows = await db.select().from(issueTemplates).where(where).orderBy(asc(issueTemplates.name));
      return Response.json({ templates: await Promise.all(rows.map(async (row) => ({ ...row, defaultsError: await invalidDefaults(row, workspaceId) }))) });
    }
    const [row] = await db.select().from(issueTemplates).where(where);
    if (!row) return jsonError("Template not found", 404);
    const error = await invalidDefaults(row, workspaceId);
    if (path[1] === "apply" && error) return jsonError(error, 409);
    return Response.json({ ...row, defaultsError: error });
  }
  if (path[1]) return jsonError("Method not allowed", 405);
  if (access.membership.role !== "Admin") return jsonError("Admin role required", 403);
  try {
    if (!id && request.method === "POST") {
      const parsed = await validateMutationAndParse(request, fields); if ("response" in parsed) return parsed.response;
      const error = await invalidDefaults(parsed.data, workspaceId); if (error) return jsonError(error, 400);
      const [row] = await db.insert(issueTemplates).values({ workspaceId, ...parsed.data }).returning();
      return Response.json(row, { status: 201 });
    }
    if (id && (request.method === "PATCH" || request.method === "DELETE")) {
      const parsed = await validateMutationAndParse(request, request.method === "DELETE" ? version : update); if ("response" in parsed) return parsed.response;
      const [current] = await db.select().from(issueTemplates).where(where);
      if (!current) return jsonError("Template not found", 404);
      if (current.version !== parsed.data.version) return Response.json({ error: "This template changed. Your draft is kept; review the latest version before retrying.", current }, { status: 409 });
      const condition = and(where, eq(issueTemplates.version, parsed.data.version));
      if (request.method === "DELETE") {
        const removed = await db.delete(issueTemplates).where(condition).returning({ id: issueTemplates.id });
        return removed.length ? Response.json({ deleted: true }) : jsonError("This template changed. Reload before deleting.", 409);
      }
      const data = update.parse(parsed.data); const error = await invalidDefaults(data, workspaceId); if (error) return jsonError(error, 400);
      const { version: _version, ...values } = data;
      const [row] = await db.update(issueTemplates).set({ ...values, version: sql`${issueTemplates.version} + 1`, updatedAt: new Date() }).where(condition).returning();
      return row ? Response.json(row) : jsonError("This template changed. Your draft is kept; reload its version before retrying.", 409);
    }
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") return jsonError("A template with this name already exists.", 409);
    throw error;
  }
  return jsonError("Method not allowed", 405);
}
