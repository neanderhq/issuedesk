import { AuthForm } from "@/components/auth-form";

type ResetPageProps = { searchParams: Promise<{ token?: string | string[] }> };

export default async function ResetPasswordPage({ searchParams }: ResetPageProps) {
  const params = await searchParams;
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  return <AuthForm mode="reset" token={token} />;
}
