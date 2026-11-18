import { AuthForm } from "@/components/auth-form";

type InvitePageProps = { searchParams: Promise<{ token?: string | string[] }> };

export default async function InvitePage({ searchParams }: InvitePageProps) {
  const params = await searchParams;
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  return <AuthForm mode="invite" token={token} />;
}
