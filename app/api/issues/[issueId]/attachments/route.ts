import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { jsonError, requireWorkspaceAccess, runRoute, validateMultipartMutation } from "@/server/http";
import { maxAttachmentBytes, safeAttachmentName, validateAttachmentFile } from "@/server/attachment-files";
import { activity, attachments, issues, user } from "@/server/schema";

type RouteContext = { params: Promise<{ issueId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext) {
  return runRoute("issue-attachments-list", () => listIssueAttachments(request, context));
}

async function listIssueAttachments(request: Request, context: RouteContext) {
  const access = await requireWorkspaceAccess(request);
  if ("response" in access) return access.response;
  const { issueId } = await context.params;
  const parsedId = z.uuid().safeParse(issueId);
  if (!parsedId.success) return jsonError("Issue id is invalid", 400);
  const database = getDb();
  const [issue] = await database.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, parsedId.data), eq(issues.workspaceId, access.membership.workspaceId),
  )).limit(1);
  if (!issue) return jsonError("Issue not found", 404);
  const rows = await database.select({
    id: attachments.id,
    fileName: attachments.fileName,
    contentType: attachments.contentType,
    size: attachments.size,
    uploadedById: attachments.uploadedById,
    createdAt: attachments.createdAt,
    uploaderName: user.name,
  }).from(attachments)
    .leftJoin(user, eq(attachments.uploadedById, user.id))
    .where(and(eq(attachments.issueId, issue.id), eq(attachments.workspaceId, access.membership.workspaceId)))
    .orderBy(asc(attachments.createdAt));
  return Response.json({ attachments: rows.map((attachment) => ({
    ...attachment,
    uploaderName: attachment.uploaderName ?? "A former member",
    canDelete: attachment.uploadedById === access.session.user.id || access.membership.role === "Admin",
  })) }, { headers: { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie" } });
}

export async function POST(request: Request, context: RouteContext) {
  return runRoute("issue-attachment-upload", () => uploadIssueAttachment(request, context));
}

async function uploadIssueAttachment(request: Request, context: RouteContext) {
  const invalid = await validateMultipartMutation(request);
  if (invalid) return invalid;
  const access = await requireWorkspaceAccess(request);
  if ("response" in access) return access.response;
  const { issueId } = await context.params;
  const parsedId = z.uuid().safeParse(issueId);
  if (!parsedId.success) return jsonError("Issue id is invalid", 400);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Upload must be valid multipart form data", 400);
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) return jsonError("Choose exactly one file to upload", 400);
  const uploaded = files[0];
  if (uploaded.size > maxAttachmentBytes) return jsonError("Files must be 5 MB or smaller", 413);
  const fileName = safeAttachmentName(uploaded.name);
  if (!fileName) return jsonError("File name is invalid or too long", 400);
  const bytes = Buffer.from(await uploaded.arrayBuffer());
  const detected = validateAttachmentFile(fileName, bytes);
  if ("error" in detected && typeof detected.error === "string") return jsonError(detected.error, detected.status);

  const database = getDb();
  const result = await database.transaction(async (transaction) => {
    const [issue] = await transaction.select({ id: issues.id, archivedAt: issues.archivedAt }).from(issues)
      .where(and(eq(issues.id, parsedId.data), eq(issues.workspaceId, access.membership.workspaceId))).for("update").limit(1);
    if (!issue) return { response: jsonError("Issue not found", 404) };
    if (issue.archivedAt) return { response: jsonError("Archived issues cannot receive attachments", 409) };
    const [attachmentCount] = await transaction.select({ value: count() }).from(attachments).where(and(
      eq(attachments.issueId, issue.id), eq(attachments.workspaceId, access.membership.workspaceId),
    ));
    if (attachmentCount.value >= 10) return { response: jsonError("An issue can have at most 10 attachments", 400) };
    const [created] = await transaction.insert(attachments).values({
      workspaceId: access.membership.workspaceId,
      issueId: issue.id,
      uploadedById: access.session.user.id,
      fileName,
      contentType: detected.contentType,
      size: bytes.length,
      bytes,
    }).returning({ id: attachments.id, fileName: attachments.fileName, contentType: attachments.contentType, size: attachments.size, uploadedById: attachments.uploadedById, createdAt: attachments.createdAt });
    await transaction.insert(activity).values({
      workspaceId: access.membership.workspaceId,
      issueId: issue.id,
      actorId: access.session.user.id,
      action: "attachment_added",
      nextValue: { attachmentId: created.id, fileName: created.fileName },
    });
    return { attachment: { ...created, uploaderName: access.session.user.name, canDelete: true } };
  });
  if ("response" in result) return result.response;
  return Response.json({ attachment: result.attachment }, { status: 201 });
}
