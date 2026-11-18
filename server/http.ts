import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z, type ZodType } from "zod";
import { getAuth } from "./auth";
import { getDb } from "./db";
import { loginRateLimits, memberships, workspaces } from "./schema";

const jsonLimit = 64 * 1024;
const multipartLimit = 5 * 1024 * 1024 + 128 * 1024;

export function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "127.0.0.1";
}

export async function consumeRateLimit(key: string, maximumAttempts: number, windowMilliseconds: number) {
  const keyHash = createHash("sha256").update(key).digest("hex");
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMilliseconds);
  const [entry] = await getDb().insert(loginRateLimits).values({ ipHash: keyHash, windowStartedAt: now, attempts: 1 })
    .onConflictDoUpdate({
      target: loginRateLimits.ipHash,
      set: {
        windowStartedAt: sql`CASE WHEN ${loginRateLimits.windowStartedAt} < ${cutoff} THEN ${now} ELSE ${loginRateLimits.windowStartedAt} END`,
        attempts: sql`CASE WHEN ${loginRateLimits.windowStartedAt} < ${cutoff} THEN 1 ELSE ${loginRateLimits.attempts} + 1 END`,
      },
    })
    .returning({ attempts: loginRateLimits.attempts });
  return entry.attempts <= maximumAttempts;
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function validateOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = process.env.NODE_ENV === "production"
    ? [new URL(process.env.BETTER_AUTH_URL || "").origin]
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
  if (!origin || !allowedOrigins.includes(origin)) return jsonError("Request origin is not allowed", 403);
  return null;
}

async function validateBodyLimit(request: Request, limit: number, message: string) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) return jsonError(message, 413);
  const reader = request.clone().body?.getReader();
  if (reader) {
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return jsonError(message, 413);
      }
    }
  }
  return null;
}

export async function validateMutation(request: Request) {
  const originError = validateOrigin(request);
  if (originError) return originError;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonError("Content-Type must be application/json", 415);
  }
  return validateBodyLimit(request, jsonLimit, "Request body exceeds 64 KB");
}

export async function validateMultipartMutation(
  request: Request,
  maxBytes = multipartLimit,
  limitMessage = "Upload request exceeds the 5 MB file limit",
) {
  const originError = validateOrigin(request);
  if (originError) return originError;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return jsonError("Content-Type must be multipart/form-data", 415);
  }
  return validateBodyLimit(request, maxBytes, limitMessage);
}

export async function parseJson<T extends ZodType>(request: Request, schema: T): Promise<{ data: z.infer<T> } | { response: Response }> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return { response: jsonError("Request body must be valid JSON", 400) };
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return { response: jsonError(`${field}${issue.message}`, 400) };
  }
  return { data: result.data };
}

export async function runRoute(label: string, handler: () => Promise<Response | undefined>) {
  try {
    return await handler() ?? jsonError("Unexpected server response", 500);
  } catch (error) {
    console.error(`[${label}]`, error);
    return jsonError("Unexpected server error", 500);
  }
}

export async function requireWorkspaceAccess(request: Request, adminOnly = false) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError("Sign in required", 401) } as const;
  const [membership] = await getDb()
    .select({ id: memberships.id, role: memberships.role, workspaceId: workspaces.id, workspaceName: workspaces.name, issueKeyPrefix: workspaces.issueKeyPrefix })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(and(eq(memberships.userId, session.user.id), eq(memberships.active, true)))
    .limit(1);
  if (!membership) return { response: jsonError("Active workspace membership required", 403) } as const;
  if (adminOnly && membership.role !== "Admin") return { response: jsonError("Admin role required", 403) } as const;
  return { session, membership } as const;
}

export async function validateMutationAndParse<T extends ZodType>(request: Request, schema: T) {
  const invalid = await validateMutation(request);
  if (invalid) return { response: invalid } as const;
  return parseJson(request, schema);
}
