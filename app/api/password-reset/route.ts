import { jsonError, runRoute, validateMutation } from "../../../server/http";
import { getAuth } from "../../../server/auth";
import { z } from "zod";
import { passwordInput, textInput } from "../../../server/validation";

const resetSchema = z.object({
  token: textInput(500, "Reset token must be 500 characters or fewer").min(20, "Reset token is required"),
  newPassword: passwordInput(),
});

export async function POST(request: Request) {
  return runRoute("password-reset", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return jsonError("Request body must be valid JSON", 400);
    }
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) return jsonError(parsed.error.issues[0].message, 400);
    const baseURL = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000";
    const response = await getAuth().handler(new Request(new URL("/api/auth/reset-password", baseURL), {
      method: "POST",
      headers: { "content-type": "application/json", origin: request.headers.get("origin") || "" },
      body: JSON.stringify(parsed.data),
    }));
    return new Response(await response.text(), { status: response.status, headers: response.headers });
  });
}
