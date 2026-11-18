import { toNextJsHandler } from "better-auth/next-js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getAuth } from "../../../../server/auth";
import { clientIp, consumeRateLimit, validateMutation, jsonError, runRoute, requireWorkspaceAccess } from "../../../../server/http";
import { getDb } from "../../../../server/db";
import { memberships, user } from "../../../../server/schema";
import { passwordInput, textInput } from "../../../../server/validation";

const removedWorkspaceAccessMessage = "Your access to this workspace was removed. Ask an Admin to invite you again.";
const signInSchema = z.object({
  email: textInput(320).pipe(z.email()).transform((value) => value.toLowerCase()),
  password: passwordInput(1),
}).passthrough();

const authHandlers = () => toNextJsHandler(getAuth());

export const dynamic = "force-dynamic";

function routePath(request: Request) {
  return new URL(request.url).pathname.replace(/^\/api\/auth/, "");
}

async function limitLogin(request: Request) {
  return consumeRateLimit(`login:${clientIp(request)}`, 5, 60_000);
}

async function rejectRemovedWorkspaceUser(request: Request) {
  let email: unknown;
  try {
    email = (await request.clone().json()).email;
  } catch {
    return null;
  }
  if (typeof email !== "string") return null;
  const [account] = await getDb().select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase())).limit(1);
  if (!account) return null;
  const [membership] = await getDb().select({ id: memberships.id }).from(memberships).where(and(
    eq(memberships.userId, account.id),
    eq(memberships.active, true),
  )).limit(1);
  return membership ? null : Response.json({ message: removedWorkspaceAccessMessage }, { status: 403 });
}

export async function GET(request: Request) {
  if (routePath(request) !== "/get-session") return jsonError("Authentication route not found", 404);
  return runRoute("auth:get-session", async () => authHandlers().GET(request));
}

export async function POST(request: Request) {
  return runRoute("auth:post", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const path = routePath(request);
    if (path === "/sign-up/email" || path === "/request-password-reset" || path === "/reset-password" || path.startsWith("/reset-password/")) {
      return jsonError("Use the workspace account flow", 400);
    }
    if (path === "/sign-in/email") {
      if (!(await limitLogin(request))) return jsonError("Too many login attempts. Try again in one minute.", 429);
      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        return jsonError("Request body must be valid JSON", 400);
      }
      const parsed = signInSchema.safeParse(body);
      if (!parsed.success) return jsonError(parsed.error.issues[0].message, 400);
      const removedAccess = await rejectRemovedWorkspaceUser(request);
      if (removedAccess) return removedAccess;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      return authHandlers().POST(new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify({ ...(body as Record<string, unknown>), ...parsed.data }),
      }));
    }
    if (path !== "/sign-in/email" && path !== "/sign-out") return jsonError("Authentication route not found", 404);
    if (path === "/sign-out") {
      const access = await requireWorkspaceAccess(request);
      if ("response" in access) return access.response;
    }
    return authHandlers().POST(request);
  });
}
