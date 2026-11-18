"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/app/auth-client";

type AuthFormProps = {
  mode: "login" | "signup" | "invite" | "forgot" | "reset";
  token?: string;
  expired?: boolean;
  sessionEnded?: boolean;
  next?: string;
};

function safePostLoginPath(value: string | undefined) {
  if (!value || value.trim() !== value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/inbox";

  try {
    const decodedValue = decodeURIComponent(value);
    if (!decodedValue.startsWith("/") || decodedValue.startsWith("//") || decodedValue.includes("\\") || /[\u0000-\u001f\u007f]/.test(decodedValue)) return "/inbox";
    const destination = new URL(value, window.location.origin);
    if (destination.origin !== window.location.origin) return "/inbox";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/inbox";
  }
}

async function submitJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || result.message || "Unable to complete this request");
  return result;
}

export function AuthForm({ mode, token, expired = false, sessionEnded = false, next }: AuthFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [bootstrapAllowed, setBootstrapAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (mode === "signup" || mode === "login") {
      void fetch("/api/registration-status").then((response) => response.json()).then((result) => setBootstrapAllowed(Boolean(result.bootstrapAllowed))).catch(() => setBootstrapAllowed(false));
    }
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      if (mode === "login") {
        const result = await authClient.signIn.email({ email: email.trim().toLowerCase(), password });
        if (result.error) throw new Error(result.error.message || "Unable to sign in");
        window.location.assign(sessionEnded ? safePostLoginPath(next) : "/");
      } else if (mode === "signup" || mode === "invite") {
        await submitJson("/api/signup", { name: name.trim(), email: email.trim().toLowerCase(), password, ...(token ? { invitationToken: token } : {}) });
        window.location.assign("/");
      } else if (mode === "forgot") {
        await submitJson("/api/password-reset-requests", { email: email.trim().toLowerCase() });
        setMessage("If this account exists, an administrator can provide a reset link.");
      } else {
        await submitJson("/api/password-reset", { token, newPassword: password });
        setMessage("Your password has been updated. You can now sign in.");
        setPassword("");
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to complete this request");
    } finally {
      setPending(false);
    }
  }

  const title = mode === "login" ? "Welcome back"
    : mode === "signup" ? "Create your workspace"
      : mode === "invite" ? "Join your team"
        : mode === "forgot" ? "Forgot password"
          : "Choose a new password";
  const description = mode === "login" ? "Sign in to your team workspace."
    : mode === "signup" ? "The first account becomes the workspace Admin."
      : mode === "invite" ? "Create your account using your invitation."
        : mode === "forgot" ? "An Admin can create a private reset link for you. Nothing will be emailed."
          : "Use a password with at least 12 characters.";

  return <main className="flex min-h-dvh items-center justify-center overflow-x-hidden bg-background px-4 py-8 text-foreground">
    <Card className="w-full max-w-md gap-5">
      <CardHeader className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Linear</p>
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessionEnded
          ? <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="status">Your session has ended. Sign in again.</p>
          : expired && <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="status">Your session expired or was revoked. Please sign in again.</p>}
        {mode === "signup" && bootstrapAllowed === false && <p className="mb-4 rounded-md border bg-muted p-3 text-sm text-muted-foreground">New accounts can join only with a valid invitation link.</p>}
        <form className="space-y-4" onSubmit={submit}>
          {(mode === "signup" || mode === "invite") && <div className="space-y-2"><Label htmlFor="name">Your name</Label><Input id="name" autoComplete="name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} required /></div>}
          {mode !== "reset" && <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>}
          {(mode === "login" || mode === "signup" || mode === "invite" || mode === "reset") && <div className="space-y-2"><Label htmlFor="password">{mode === "reset" ? "New password" : "Password"}</Label><Input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? 1 : 12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></div>}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {message && <p className="text-sm text-success" role="status">{message}</p>}
          <Button className="w-full" type="submit" disabled={pending || (mode === "signup" && bootstrapAllowed !== true) || (mode === "invite" && !token)}>
            {pending ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create workspace" : mode === "invite" ? "Join workspace" : mode === "forgot" ? "Request a reset link" : "Update password"}
          </Button>
        </form>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          {mode === "login" ? <><Link className="underline underline-offset-4" href="/forgot-password">Forgot password?</Link>{bootstrapAllowed && <Link className="underline underline-offset-4" href="/signup">Create workspace</Link>}</> : <Link className="underline underline-offset-4" href="/login">Back to sign in</Link>}
        </div>
      </CardContent>
    </Card>
  </main>;
}
