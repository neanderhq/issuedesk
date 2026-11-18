"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestJson } from "@/components/issues/issue-api";
import { authClient } from "@/app/auth-client";

type Role = "Admin" | "Member";
type Member = { id: string; name: string; email: string; role: Role; active: boolean; createdAt: string };
type Invitation = { id: string; email: string; role: Role; expiresAt: string };
type ResetRequest = { id: string; email: string; createdAt: string };
type MembersData = { members: Member[]; invitations: Invitation[]; resetRequests: ResetRequest[] };

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function dateLabel(value: string) {
  return new Date(value).toISOString().slice(0, 10);
}

export function MembersSettings({ role }: { role: Role }) {
  const [data, setData] = useState<MembersData | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("Member");
  const [inviteLink, setInviteLink] = useState("");
  const [generatedLink, setGeneratedLink] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function reload() {
    const result = await requestJson<MembersData>("/api/settings/members");
    setData(result);
  }

  useEffect(() => {
    if (role === "Admin") void reload().catch((loadError) => setError(loadError.message));
  }, [role]);

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    setInviteLink("");
    try {
      const result = await requestJson<{ inviteUrl: string }>("/api/settings/invitations", jsonRequest("POST", { email: email.trim(), role: inviteRole }));
      setInviteLink(result.inviteUrl);
      setEmail("");
      setMessage("Invitation link created. Share it directly with the invited person; it is not emailed.");
      await reload();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not create invitation");
    } finally {
      setPending(false);
    }
  }

  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    setError("");
    setMessage("");
    setGeneratedLink("");
    setPending(true);
    try {
      const result = await action();
      if (result && typeof result === "object" && "resetLink" in result && typeof result.resetLink === "string") setGeneratedLink(result.resetLink);
      setMessage(successMessage);
      await reload();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not complete this action");
    } finally {
      setPending(false);
    }
  }

  if (role !== "Admin") return <section className="space-y-2"><h2 className="text-lg font-semibold">Members</h2><p className="text-sm text-muted-foreground">Only workspace Admins can manage invitations, member roles, and password resets.</p></section>;

  return <section className="space-y-6">
    <div className="space-y-1"><h2 className="text-lg font-semibold">Members</h2><p className="text-sm text-muted-foreground">Manage invitations and access for up to 10 active members and pending invitations combined.</p></div>
    <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end" onSubmit={createInvite}>
      <div className="space-y-2"><Label htmlFor="invite-email">Invite by email</Label><Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
      <div className="space-y-2"><Label htmlFor="invite-role">Role</Label><select id="invite-role" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}><option value="Member">Member</option><option value="Admin">Admin</option></select></div>
      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create invite"}</Button>
    </form>
    {inviteLink && <div className="space-y-2 rounded-lg border bg-muted/50 p-3"><Label htmlFor="invite-link">Copyable invitation link</Label><div className="flex min-w-0 flex-col gap-2 sm:flex-row"><Input id="invite-link" readOnly value={inviteLink} className="min-w-0" /><Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(inviteLink)}>Copy link</Button></div></div>}
    {data && <>
      <div className="space-y-3"><h3 className="font-medium">Team members</h3><div className="space-y-2">
        {data.members.map((member) => <div key={member.id} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="truncate font-medium">{member.name}{member.active ? "" : " (removed)"}</p><p className="truncate text-sm text-muted-foreground">{member.email}</p></div>
          {member.active ? <div className="flex flex-wrap items-center gap-2">
            <select aria-label={`Role for ${member.name}`} className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={member.role} disabled={pending} onChange={(event) => void runAction(() => requestJson(`/api/settings/members/${member.id}`, jsonRequest("PATCH", { role: event.target.value })), "Member role updated")}><option value="Admin">Admin</option><option value="Member">Member</option></select>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void runAction(() => requestJson(`/api/settings/members/${member.id}/password-reset`, jsonRequest("POST", {})), "One-time reset link generated")}>Reset password</Button>
            <Button type="button" variant="destructive" size="sm" disabled={pending || (member.role === "Admin" && data.members.filter((item) => item.active && item.role === "Admin").length === 1)} onClick={() => { if (window.confirm(`Remove ${member.name} from this workspace?`)) void runAction(() => requestJson(`/api/settings/members/${member.id}`, jsonRequest("DELETE", {})), "Member removed and their sessions revoked"); }}>Remove</Button>
          </div> : <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void runAction(() => requestJson(`/api/settings/members/${member.id}`, jsonRequest("PATCH", { active: true })), "Member restored")}>Restore</Button>}
        </div>)}
      </div></div>
      <div className="space-y-3"><h3 className="font-medium">Pending invitations</h3>{data.invitations.length ? data.invitations.map((invitation) => <div key={invitation.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate font-medium">{invitation.email}</p><p className="text-sm text-muted-foreground">{invitation.role} · expires {dateLabel(invitation.expiresAt)} UTC</p></div><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void runAction(() => requestJson(`/api/settings/invitations/${invitation.id}`, jsonRequest("DELETE", {})), "Invitation revoked")}>Revoke</Button></div>) : <p className="text-sm text-muted-foreground">No pending invitations.</p>}</div>
      <div className="space-y-3"><h3 className="font-medium">Password reset requests</h3>{data.resetRequests.length ? data.resetRequests.map((request) => {
        const member = data.members.find((candidate) => candidate.active && candidate.email.toLowerCase() === request.email.toLowerCase());
        return <div key={request.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate font-medium">{request.email}</p><p className="text-sm text-muted-foreground">Requested {dateLabel(request.createdAt)} UTC</p></div>{member ? <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void runAction(() => requestJson(`/api/settings/members/${member.id}/password-reset`, jsonRequest("POST", {})), "One-time reset link generated")}>Generate reset link</Button> : <span className="text-sm text-muted-foreground">No active member matches this email.</span>}</div>;
      }) : <p className="text-sm text-muted-foreground">No pending requests.</p>}</div>
    </>}
    {generatedLink && <div className="space-y-2 rounded-lg border bg-muted/50 p-3"><Label htmlFor="reset-link">One-time reset link (valid for one hour)</Label><div className="flex min-w-0 flex-col gap-2 sm:flex-row"><Input id="reset-link" readOnly value={generatedLink} className="min-w-0" /><Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(generatedLink)}>Copy link</Button></div></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm text-success">{message}</p>}
  </section>;
}

export function WorkspaceSettings({ role, name, email }: { role: Role; name: string; email: string }) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [prefix, setPrefix] = useState("TT");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState("");

  useEffect(() => {
    void requestJson<{ workspace: { name: string; issueKeyPrefix: string } }>("/api/settings/workspace")
      .then((result) => { setWorkspaceName(result.workspace.name); setPrefix(result.workspace.issueKeyPrefix); })
      .catch((loadError) => setError(loadError.message));
  }, []);

  async function saveWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      await requestJson("/api/settings/workspace", jsonRequest("PUT", { name: workspaceName, issueKeyPrefix: prefix }));
      setMessage("Workspace settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save workspace settings");
    } finally {
      setPending(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      await requestJson("/api/account/password", jsonRequest("POST", { currentPassword, newPassword }));
      setCurrentPassword("");
      setNewPassword("");
      setMessage("Password updated. Your other sessions have been signed out.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not change password");
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    setSignOutPending(true);
    setSignOutError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Could not sign out");
      window.location.assign("/login");
    } catch (signOutActionError) {
      setSignOutError(signOutActionError instanceof Error ? signOutActionError.message : "Could not sign out");
    } finally {
      setSignOutPending(false);
    }
  }

  return <section className="space-y-6">
    <div className="space-y-1"><h2 className="text-lg font-semibold">Workspace</h2><p className="text-sm text-muted-foreground">Signed in as {name} · {email}</p></div>
    <form className="grid gap-4 sm:max-w-xl" onSubmit={saveWorkspace}>
      <div className="space-y-2"><Label htmlFor="workspace-name">Workspace name</Label><Input id="workspace-name" maxLength={120} value={workspaceName} disabled={role !== "Admin"} onChange={(event) => setWorkspaceName(event.target.value)} required /></div>
      <div className="space-y-2"><Label htmlFor="issue-prefix">Issue key prefix</Label><Input id="issue-prefix" maxLength={8} value={prefix} disabled={role !== "Admin"} onChange={(event) => setPrefix(event.target.value.toUpperCase())} required /></div>
      {role === "Admin" && <Button type="submit" className="w-fit" disabled={pending}>Save workspace</Button>}
    </form>
    <div className="border-t pt-5"><h3 className="font-medium">Change your password</h3><p className="mt-1 text-sm text-muted-foreground">Your other signed-in sessions will be revoked after the change.</p>
      <form className="mt-4 grid gap-4 sm:max-w-xl" onSubmit={changePassword}>
        <div className="space-y-2"><Label htmlFor="current-password">Current password</Label><Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></div>
        <div className="space-y-2"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></div>
        <Button type="submit" variant="outline" className="w-fit" disabled={pending}>Update password</Button>
      </form>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm text-success">{message}</p>}
    <div className="border-t pt-5"><h3 className="font-medium">Sign out</h3><p className="mt-1 text-sm text-muted-foreground">Sign out of this workspace on this device.</p>
      <Button type="button" variant="outline" className="mt-4 w-fit" disabled={signOutPending} onClick={() => void signOut()}>Sign out</Button>
      {signOutError && <p role="alert" className="mt-2 text-sm text-destructive">{signOutError}</p>}
    </div>
  </section>;
}
