import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "./db";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createAuth(sendResetPassword?: (url: string, token?: string) => Promise<void>) {
  const baseURL = process.env.BETTER_AUTH_URL || (process.env.NODE_ENV === "production" ? required("BETTER_AUTH_URL") : "http://127.0.0.1:3000");
  const trustedOrigins = process.env.NODE_ENV === "production"
    ? [new URL(required("BETTER_AUTH_URL")).origin]
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
  return betterAuth({
    baseURL,
    trustedOrigins,
    secret: required("BETTER_AUTH_SECRET"),
    database: drizzleAdapter(getDb(), { provider: "pg" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ url, token }) => sendResetPassword?.(url, token),
    },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  return auth ??= createAuth();
}

export function createResetAuth(sendResetPassword: (url: string, token?: string) => Promise<void>) {
  return createAuth(sendResetPassword);
}
