import { z } from "zod";
import { getAuth } from "../../../../server/auth";
import { jsonError, requireWorkspaceAccess, runRoute, validateMutation } from "../../../../server/http";
import { passwordInput } from "../../../../server/validation";

const passwordSchema = z.object({
  currentPassword: passwordInput(1),
  newPassword: passwordInput(),
});

export async function POST(request: Request) {
  return runRoute("change-password", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    const access = await requireWorkspaceAccess(request);
    if ("response" in access) return access.response;
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return jsonError("Request body must be valid JSON", 400);
    }
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success) return jsonError(parsed.error.issues[0].message, 400);
    const baseURL = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000";
    const response = await getAuth().handler(new Request(new URL("/api/auth/change-password", baseURL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: request.headers.get("origin") || "",
        cookie: request.headers.get("cookie") || "",
      },
      body: JSON.stringify({ ...parsed.data, revokeOtherSessions: true }),
    }));
    return new Response(await response.text(), { status: response.status, headers: response.headers });
  });
}
