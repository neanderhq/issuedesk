import { githubWebhookRoute } from "@/server/github-integration";
import { runRoute } from "@/server/http";
export const dynamic = "force-dynamic";
export function POST(request:Request){return runRoute("github-webhook",()=>githubWebhookRoute(request));}
