import { z } from "zod";
import { getDb } from "../../../server/db";
import { clientIp, consumeRateLimit, jsonError, runRoute, validateMutation } from "../../../server/http";
import { passwordResetRequests } from "../../../server/schema";
import { textInput } from "../../../server/validation";

const requestSchema = z.object({ email: textInput(320).pipe(z.email()).transform((value) => value.toLowerCase()) });

export async function POST(request: Request) {
  return runRoute("password-reset-request", async () => {
    const invalid = await validateMutation(request);
    if (invalid) return invalid;
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return jsonError("Request body must be valid JSON", 400);
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return jsonError(parsed.error.issues[0].message, 400);
    const emailAllowed = await consumeRateLimit(`password-reset-email:${parsed.data.email}`, 3, 60 * 60 * 1000);
    const ipAllowed = await consumeRateLimit(`password-reset-ip:${clientIp(request)}`, 3, 60 * 60 * 1000);
    if (!emailAllowed || !ipAllowed) return jsonError("Too many password reset requests. Try again later.", 429);
    await getDb().insert(passwordResetRequests).values({ email: parsed.data.email });
    return Response.json({ message: "If this account exists, an administrator can provide a reset link." });
  });
}
