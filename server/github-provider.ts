import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { z } from "zod";

export type GitHubConfiguration = { appId: string; privateKey: string; installationId: number; repository: string; webhookSecret: string };
export function githubConfiguration(): GitHubConfiguration | null {
  const appId=process.env.GITHUB_APP_ID?.trim();const privateKey=process.env.GITHUB_APP_PRIVATE_KEY;const installation=process.env.GITHUB_INSTALLATION_ID;const repository=process.env.GITHUB_REPOSITORY?.trim();const webhookSecret=process.env.GITHUB_WEBHOOK_SECRET;
  if(!appId||!privateKey||!installation||!repository||!webhookSecret)return null;
  if(!/^\d+$/.test(installation)||!Number.isSafeInteger(Number(installation))||Number(installation)<1||!/^[-\w.]+\/[-\w.]+$/.test(repository)||repository.length>200)return null;
  return {appId,privateKey:privateKey.replace(/\\n/g,"\n"),installationId:Number(installation),repository,webhookSecret};
}
export class GitHubProviderError extends Error {
  constructor(readonly kind:"revoked"|"stale"|"invalid",message:string){super(message);}
}
const providerId=z.number().int().positive().safe();
const repositorySchema=z.object({id:providerId,full_name:z.string().min(3).max(200),default_branch:z.string().max(255),private:z.boolean()});
export const pullRequestSchema=z.object({
  id:providerId,number:z.number().int().positive().max(2147483647),title:z.string().min(1).max(500),state:z.enum(["open","closed"]),draft:z.boolean().optional(),merged:z.boolean().optional(),merged_at:z.iso.datetime({offset:true}).nullable(),updated_at:z.iso.datetime({offset:true}),
  base:z.object({ref:z.string().min(1).max(255),repo:z.object({id:providerId,full_name:z.string().min(3).max(200)})}),
}).refine(pr=>!pr.merged||!!pr.merged_at,"Merged pull requests must include a merge date");
export type VerifiedPullRequest = {providerId:number;number:number;title:string;state:"Open"|"Draft"|"Closed"|"Merged";url:string;baseBranch:string;providerUpdatedAt:Date};
export function normalizePullRequest(value:unknown,repositoryId:number,fullName:string):VerifiedPullRequest {
  const parsed=pullRequestSchema.safeParse(value);
  if(!parsed.success)throw new GitHubProviderError("stale","GitHub returned an incomplete pull request. Try refreshing later.");
  const pr=parsed.data;
  if(pr.base.repo.id!==repositoryId||pr.base.repo.full_name.toLowerCase()!==fullName.toLowerCase())throw new GitHubProviderError("invalid","This pull request belongs to a different repository.");
  if(pr.merged_at&&pr.state!=="closed")throw new GitHubProviderError("stale","GitHub returned inconsistent pull request state.");
  return {providerId:pr.id,number:pr.number,title:pr.title,state:pr.merged_at?"Merged":pr.state==="closed"?"Closed":pr.draft?"Draft":"Open",url:`https://github.com/${fullName}/pull/${pr.number}`,baseBranch:pr.base.ref,providerUpdatedAt:new Date(pr.updated_at)};
}
export function parsePullRequestUrl(value:string,fullName:string) {
  let url:URL;try{url=new URL(value);}catch{throw new GitHubProviderError("invalid","Enter a GitHub pull request URL.");}
  const match=url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if(url.protocol!=="https:"||url.hostname!=="github.com"||url.port||url.username||url.password||url.search||url.hash||!match||`${match[1]}/${match[2]}`.toLowerCase()!==fullName.toLowerCase()||!Number.isSafeInteger(Number(match[3]))||Number(match[3])>2147483647)throw new GitHubProviderError("invalid","Use a pull request URL from the connected GitHub repository.");
  return Number(match[3]);
}

const githubRequest=request.defaults({headers:{accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"},request:{timeout:10000}});
let cached:{key:string;auth:ReturnType<typeof createAppAuth>}|undefined;
function authFor(config:GitHubConfiguration){
  const key=JSON.stringify([config.appId,config.privateKey,config.installationId,config.repository]);
  if(cached?.key!==key)cached={key,auth:createAppAuth({appId:config.appId,privateKey:config.privateKey,installationId:config.installationId,request:githubRequest})};
  return cached.auth;
}
async function providerCall<T>(call:()=>Promise<T>,missing:"revoked"|"invalid"="revoked"):Promise<T>{
  try{return await call();}catch(error){
    if(error instanceof GitHubProviderError)throw error;
    const status=(error as {status?:number}).status;
    const headers=(error as {response?:{headers?:Record<string,string>}}).response?.headers;
    if(status===403&&(headers?.["x-ratelimit-remaining"]==="0"||headers?.["retry-after"]))throw new GitHubProviderError("stale","GitHub is rate limited. Last verified data is retained; try later.");
    if(status===404&&missing==="invalid")throw new GitHubProviderError("invalid","This pull request could not be found in the connected repository.");
    if(status===401||status===403||status===404)throw new GitHubProviderError("revoked","GitHub access is unavailable or revoked. An Admin must verify the connection.");
    // Never log the Octokit error/request: it can contain credentials and provider data.
    console.error("[github] provider request failed",status??"network/configuration");
    throw new GitHubProviderError("stale","GitHub could not be reached. Last verified data is retained; try again.");
  }
}
async function installationToken(config:GitHubConfiguration,refresh=false){
  const [,repo]=config.repository.split("/");
  return providerCall(()=>authFor(config)({type:"installation",installationId:config.installationId,repositoryNames:[repo],permissions:{metadata:"read",pull_requests:"read"},refresh}));
}
export async function verifyGitHubRepository(config:GitHubConfiguration){
  return providerCall(async()=>{
    const auth=await authFor(config)({type:"app"});const [owner,repo]=config.repository.split("/");
    const installation=await githubRequest("GET /repos/{owner}/{repo}/installation",{owner,repo,headers:{authorization:`Bearer ${auth.token}`}});
    const grant=z.object({id:providerId,suspended_at:z.string().nullable(),permissions:z.object({pull_requests:z.enum(["read","write"])})}).safeParse(installation.data);
    if(!grant.success||grant.data.id!==config.installationId||grant.data.suspended_at)throw new GitHubProviderError("revoked","The configured App installation does not grant pull request access to this repository.");
    const token=await installationToken(config,true);
    const result=await githubRequest("GET /repos/{owner}/{repo}",{owner,repo,headers:{authorization:`Bearer ${token.token}`}});
    const repository=repositorySchema.safeParse(result.data);
    if(!repository.success||repository.data.full_name.toLowerCase()!==config.repository.toLowerCase())throw new GitHubProviderError("revoked","The configured repository could not be verified.");
    return repository.data;
  });
}
export async function fetchGitHubPullRequest(config:GitHubConfiguration,repositoryId:number,fullName:string,number:number){
  if(fullName.toLowerCase()!==config.repository.toLowerCase())throw new GitHubProviderError("revoked","Repository configuration changed. An Admin must verify the connection.");
  const token=await installationToken(config);const [owner,repo]=fullName.split("/");
  const repository=await providerCall(()=>githubRequest("GET /repos/{owner}/{repo}",{owner,repo,headers:{authorization:`Bearer ${token.token}`}}));
  if((repository.data as {id?:number}).id!==repositoryId)throw new GitHubProviderError("revoked","Repository identity changed. An Admin must verify the connection.");
  const response=await providerCall(()=>githubRequest("GET /repos/{owner}/{repo}/pulls/{pull_number}",{owner,repo,pull_number:number,headers:{authorization:`Bearer ${token.token}`}}),"invalid");
  return normalizePullRequest(response.data,repositoryId,fullName);
}
