import { AuthForm } from "@/components/auth-form";

type LoginPageProps = { searchParams: Promise<{ expired?: string; reason?: string; next?: string | string[] }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  return <AuthForm mode="login" expired={params.expired === "1"} sessionEnded={params.reason === "session"} next={typeof params.next === "string" ? params.next : undefined} />;
}
