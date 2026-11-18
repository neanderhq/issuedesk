import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { jsonError, requireWorkspaceAccess, runRoute, validateMutation } from "@/server/http";
import { activity, attachments, issues } from "@/server/schema";

type RouteContext = { params: Promise<{ attachmentId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext) {
  return runRoute("attachment-download", () => downloadAttachment(request, context));
}

async function downloadAttachment(request: Request, context: RouteContext) {
  const access = await requireWorkspaceAccess(request);
  if ("response" in access) return access.response;
  const { attachmentId } = await context.params;
  const parsedId = z.uuid().safeParse(attachmentId);
  if (!parsedId.success) return jsonError("Attachment id is invalid", 400);
  const [attachment] = await getDb().select().from(attachments).where(and(
    eq(attachments.id, parsedId.data), eq(attachments.workspaceId, access.membership.workspaceId),
  )).limit(1);
  if (!attachment) return jsonError("Attachment not found", 404);
  const fallbackName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255) || "attachment";
  const encodedName = encodeURIComponent(attachment.fileName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = new Headers({
    "Content-Type": attachment.contentType,
    "Content-Length": String(attachment.size),
    "Content-Disposition": `${attachment.contentType.startsWith("image/") ? "inline" : "attachment"}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Cookie",
  });
  return new Response(Buffer.from(attachment.bytes), { headers });
}

export async function DELETE(request: Request, context: RouteContext) {
  return runRoute("attachment-delete", () => deleteAttachment(request, context));
}

async function deleteAttachment(request: Request, context: RouteContext) {
  const invalid = await validateMutation(request);
  if (invalid) return invalid;
  const access = await requireWorkspaceAccess(request);
  if ("response" in access) return access.response;
  const { attachmentId } = await context.params;
  const parsedId = z.uuid().safeParse(attachmentId);
  if (!parsedId.success) return jsonError("Attachment id is invalid", 400);
  const database = getDb();
  const result = await database.transaction(async (transaction) => {
    const [attachment] = await transaction.select({
      id: attachments.id,
      issueId: attachments.issueId,
      uploadedById: attachments.uploadedById,
      fileName: attachments.fileName,
      archivedAt: issues.archivedAt,
    }).from(attachments).innerJoin(issues, eq(attachments.issueId, issues.id)).where(and(
      eq(attachments.id, parsedId.data),
      eq(attachments.workspaceId, access.membership.workspaceId),
      eq(issues.workspaceId, access.membership.workspaceId),
    )).for("update", { of: attachments }).limit(1);
    if (!attachment) return { response: jsonError("Attachment not found", 404) };
    if (attachment.uploadedById !== access.session.user.id && access.membership.role !== "Admin") {
      return { response: jsonError("Only the uploader or an Admin can delete this attachment", 403) };
    }
    if (attachment.archivedAt) return { response: jsonError("Archived issues are read-only", 409) };
    await transaction.delete(attachments).where(eq(attachments.id, attachment.id));
    await transaction.insert(activity).values({
      workspaceId: access.membership.workspaceId,
      issueId: attachment.issueId,
      actorId: access.session.user.id,
      action: "attachment_removed",
      previousValue: { attachmentId: attachment.id, fileName: attachment.fileName },
    });
    return { removed: true };
  });
  if ("response" in result) return result.response;
  return Response.json(result);
}
