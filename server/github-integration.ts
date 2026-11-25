import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";
import { getDb } from "./db";
import { jsonError, requireWorkspaceAccess, validateMutationAndParse } from "./http";
import { activity, githubConnections, githubDeliveries, githubPullRequests, issueFollowers, issues, memberships, notifications, workspaces } from "./schema";
import { fetchGitHubPullRequest, GitHubProviderError, githubConfiguration, normalizePullRequest, parsePullRequestUrl, verifyGitHubRepository, type VerifiedPullRequest } from "./github-provider";

type Access = Extract<Awaited<ReturnType<typeof requireWorkspaceAccess>>, {membership:unknown}>;
type Transaction=Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Connection=typeof githubConnections.$inferSelect;
type Link=typeof githubPullRequests.$inferSelect;
const version=z.object({version:z.number().int().positive()}).strict();
const linkInput=z.object({url:z.string().max(500),completeOnMerge:z.boolean().default(false)}).strict();
const optIn=version.extend({completeOnMerge:z.boolean()});
function usable(connection:Connection|null|undefined){const config=githubConfiguration();return !!config&&!!connection&&["connected","stale"].includes(connection.status)&&connection.installationId===config.installationId&&connection.repository.toLowerCase()===config.repository.toLowerCase();}
function view(connection:Connection|undefined){const config=githubConfiguration();const configured=!!config;return {configured,connection:connection??null,status:!configured?"unconfigured":!connection?"unconnected":connection.installationId!==config.installationId||connection.repository.toLowerCase()!==config.repository.toLowerCase()?"configuration_changed":connection.status};}
async function failed(connection:Connection,error:unknown){
 if(!(error instanceof GitHubProviderError))throw error;
 if(error.kind!=="invalid")await getDb().update(githubConnections).set({status:error.kind,reason:error.message,updatedAt:new Date(),version:sql`${githubConnections.version}+1`}).where(and(eq(githubConnections.id,connection.id),eq(githubConnections.version,connection.version)));
 return jsonError(error.message,error.kind==="invalid"?400:error.kind==="revoked"?409:503);
}
async function audit(tx:Transaction,connection:Connection,link:Link,action:string,actorId:string|null){await tx.insert(activity).values({workspaceId:connection.workspaceId,issueId:link.issueId,actorId,action,metadata:{source:actorId?"member":"github",url:link.url,linkId:link.id}});}
async function complete(tx:Transaction,connection:Connection,link:Link){
 if(!link.completeOnMerge||link.state!=="Merged"||link.completionAppliedAt||link.unlinkedAt)return link;
 const [issue]=await tx.select().from(issues).where(and(eq(issues.id,link.issueId),eq(issues.workspaceId,connection.workspaceId))).for("update");
 if(!issue||issue.archivedAt)return link;
 const now=new Date();
 if(issue.status!=="Done"){
  await tx.update(issues).set({status:"Done",version:issue.version+1,updatedAt:now}).where(eq(issues.id,issue.id));
  await tx.insert(activity).values({workspaceId:connection.workspaceId,issueId:issue.id,actorId:null,action:"github_completed",field:"status",previousValue:issue.status,nextValue:"Done",metadata:{source:"github",url:link.url,linkId:link.id}});
  const recipients=await tx.select({userId:issueFollowers.userId}).from(issueFollowers).innerJoin(memberships,and(eq(memberships.userId,issueFollowers.userId),eq(memberships.workspaceId,connection.workspaceId),eq(memberships.active,true))).where(eq(issueFollowers.issueId,issue.id));
  if(recipients.length)await tx.insert(notifications).values(recipients.map(r=>({workspaceId:connection.workspaceId,issueId:issue.id,actorId:null,userId:r.userId,type:"activity",payload:{source:"github",action:"github_completed",field:"status"}})));
 }
 const [updated]=await tx.update(githubPullRequests).set({completionAppliedAt:now}).where(eq(githubPullRequests.id,link.id)).returning();return updated;
}
async function applyProvider(tx:Transaction,connection:Connection,current:Link,pr:VerifiedPullRequest,explicitOptIn?:boolean){
 // Terminal merge state and provider timestamps cannot regress under delayed deliveries/refreshes.
 const newer=current.providerUpdatedAt<=pr.providerUpdatedAt&&!(current.state==="Merged"&&pr.state!=="Merged");
 const [updated]=await tx.update(githubPullRequests).set({...(newer?{providerId:pr.providerId,number:pr.number,title:pr.title,state:pr.state,url:pr.url,baseBranch:pr.baseBranch,providerUpdatedAt:pr.providerUpdatedAt}:{}),...(explicitOptIn===undefined?{}:{completeOnMerge:explicitOptIn}),lastVerifiedAt:newer?new Date():current.lastVerifiedAt,version:current.version+1}).where(eq(githubPullRequests.id,current.id)).returning();
 return complete(tx,connection,updated);
}
export async function githubConnectionRoute(request:Request,access:Access){
 const db=getDb(),workspaceId=access.membership.workspaceId;const [connection]=await db.select().from(githubConnections).where(eq(githubConnections.workspaceId,workspaceId));
 if(request.method==="GET")return Response.json({...view(connection),canManage:access.membership.role==="Admin",offeredRepository:access.membership.role==="Admin"?githubConfiguration()?.repository??null:null});
 if(access.membership.role!=="Admin")return jsonError("Admin role required",403);
 if(!["POST","DELETE"].includes(request.method))return jsonError("Method not allowed",405);
 const input=await validateMutationAndParse(request,request.method==="POST"?z.object({shareWithWorkspace:z.literal(true),version:z.number().int().nonnegative()}).strict():version);if("response"in input)return input.response;
 const config=githubConfiguration();if(request.method==="POST"&&!config)return jsonError("GitHub is unconfigured. Ask the operator to configure the GitHub App and webhook.",409);
 let repository:Awaited<ReturnType<typeof verifyGitHubRepository>>|undefined;
 if(request.method==="POST")try{repository=await verifyGitHubRepository(config!);}catch(error){return connection?failed(connection,error):jsonError(error instanceof GitHubProviderError?error.message:"GitHub could not be verified",503);}
 return db.transaction(async tx=>{
  if(repository)await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${config!.installationId}/${repository.id}`}))`);
  // Workspace lock also serializes first-time binding; provider requests never hold a DB lock.
  await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.id,workspaceId)).for("update");
  const [current]=await tx.select().from(githubConnections).where(eq(githubConnections.workspaceId,workspaceId)).for("update");
  if((current?.version??0)!==input.data.version)return jsonError("The GitHub connection changed. Refresh and review before retrying.",409);
  if(request.method==="DELETE"){
   if(!current)return jsonError("Connection not found",404);
   await tx.update(githubPullRequests).set({completeOnMerge:false,version:sql`${githubPullRequests.version}+1`}).where(eq(githubPullRequests.connectionId,current.id));
   const [row]=await tx.update(githubConnections).set({status:"disconnected",reason:"Disconnected by an Admin. Automation is disabled.",version:current.version+1,updatedAt:new Date()}).where(eq(githubConnections.id,current.id)).returning();return Response.json(view(row));
  }
  const [boundElsewhere]=await tx.select({workspaceId:githubConnections.workspaceId}).from(githubConnections).where(and(eq(githubConnections.installationId,config!.installationId),eq(githubConnections.repositoryId,repository!.id)));
  if(boundElsewhere&&boundElsewhere.workspaceId!==workspaceId)return jsonError("This GitHub repository is already bound to another workspace.",409);
  // Re-verifying a revoked/disconnected/replaced binding never restores an old opt-in.
  if(current&&(!usable(current)||current.repositoryId!==repository!.id))await tx.update(githubPullRequests).set({completeOnMerge:false,unlinkedAt:new Date(),version:sql`${githubPullRequests.version}+1`}).where(and(eq(githubPullRequests.connectionId,current.id),isNull(githubPullRequests.unlinkedAt)));
  const values={installationId:config!.installationId,repositoryId:repository!.id,repository:repository!.full_name,status:"connected",reason:null,connectedById:access.session.user.id,lastVerifiedAt:new Date(),updatedAt:new Date(),version:(current?.version??0)+1};
  const [row]=current?await tx.update(githubConnections).set(values).where(eq(githubConnections.id,current.id)).returning():await tx.insert(githubConnections).values({...values,workspaceId}).returning();return Response.json(view(row));
 });
}
export async function githubIssueRoute(request:Request,access:Access,issueId:string,refresh=false){
 if(!z.uuid().safeParse(issueId).success)return jsonError("Issue id is invalid",400);
 const db=getDb(),workspaceId=access.membership.workspaceId;
 const [issue]=await db.select().from(issues).where(and(eq(issues.id,issueId),eq(issues.workspaceId,workspaceId)));if(!issue)return jsonError("Issue not found",404);
 const [connection]=await db.select().from(githubConnections).where(eq(githubConnections.workspaceId,workspaceId));
 const active=and(eq(githubPullRequests.issueId,issueId),eq(githubPullRequests.workspaceId,workspaceId),isNull(githubPullRequests.unlinkedAt));
 const [current]=await db.select().from(githubPullRequests).where(active);
 if(request.method==="GET"&&!refresh)return Response.json({...view(connection),link:current??null});
 if(!["POST","PATCH","DELETE"].includes(request.method)||(refresh&&request.method!=="POST"))return jsonError("Method not allowed",405);
 if(issue.archivedAt)return jsonError("Archived issues are read-only",409);
 const parsed=await validateMutationAndParse(request,refresh||request.method==="DELETE"?version:request.method==="PATCH"?optIn:linkInput);if("response"in parsed)return parsed.response;
 const input=parsed.data as {url?:string;version?:number;completeOnMerge?:boolean};
 if(!connection)return jsonError("An Admin must connect GitHub first",409);
 let pr:VerifiedPullRequest|undefined;
 const needsProvider=request.method!=="DELETE"&&!(request.method==="PATCH"&&input.completeOnMerge===false);
 if(needsProvider){
  if(!usable(connection))return jsonError("GitHub is not connected. An Admin must verify its configuration and access.",409);
  if(request.method==="POST"&&!refresh&&current)return jsonError("Unlink the existing pull request before replacing it",409);
  if((refresh||request.method==="PATCH")&&!current)return jsonError("Pull request link not found",404);
  try{const number=input.url?parsePullRequestUrl(input.url,connection.repository):current!.number;pr=await fetchGitHubPullRequest(githubConfiguration()!,connection.repositoryId,connection.repository,number);if(current&&pr.providerId!==current.providerId)throw new GitHubProviderError("revoked","Pull request identity changed. Unlink it and verify the connection.");}catch(error){return failed(connection,error);}
 }
 return db.transaction(async tx=>{
  const [locked]=await tx.select().from(githubConnections).where(eq(githubConnections.id,connection.id)).for("update");
  if(!locked||locked.version!==connection.version||(needsProvider&&!usable(locked)))return jsonError("Connection changed; refresh and review before retrying",409);
  const [lockedIssue]=await tx.select().from(issues).where(and(eq(issues.id,issueId),eq(issues.workspaceId,workspaceId))).for("update");if(!lockedIssue||lockedIssue.archivedAt)return jsonError("Issue became read-only",409);
  const [link]=await tx.select().from(githubPullRequests).where(active).for("update");
  if(input.version!==undefined&&(!link||input.version!==link.version))return Response.json({error:"Pull request link changed. Refresh before retrying.",current:link??null},{status:409});
  if(request.method==="POST"&&!refresh){
   if(link)return jsonError("Unlink the existing pull request before replacing it",409);
   const [inserted]=await tx.insert(githubPullRequests).values({workspaceId,connectionId:locked.id,issueId,...pr!,completeOnMerge:input.completeOnMerge??false,lastVerifiedAt:new Date()}).returning();await audit(tx,locked,inserted,"pull_request_linked",access.session.user.id);return Response.json(await complete(tx,locked,inserted),{status:201});
  }
  if(!link)return jsonError("Pull request link not found",404);
  if(request.method==="DELETE"){
   const [removed]=await tx.update(githubPullRequests).set({unlinkedAt:new Date(),completeOnMerge:false,version:link.version+1}).where(eq(githubPullRequests.id,link.id)).returning();await audit(tx,locked,removed,"pull_request_unlinked",access.session.user.id);return Response.json({unlinked:true});
  }
  if(!needsProvider){const [row]=await tx.update(githubPullRequests).set({completeOnMerge:false,version:link.version+1}).where(eq(githubPullRequests.id,link.id)).returning();await audit(tx,locked,row,"pull_request_automation_disabled",access.session.user.id);return Response.json(row);}
  const updated=await applyProvider(tx,locked,link,pr!,refresh?undefined:input.completeOnMerge);
  if(!refresh)await audit(tx,locked,updated,input.completeOnMerge?"pull_request_automation_enabled":"pull_request_automation_disabled",access.session.user.id);
  await tx.update(githubConnections).set({status:"connected",reason:null,lastVerifiedAt:new Date()}).where(eq(githubConnections.id,locked.id));return Response.json(updated);
 });
}

const envelope=z.object({action:z.string().optional(),installation:z.object({id:z.number().int().positive().safe()}),repository:z.object({id:z.number().int().positive().safe()}).optional(),pull_request:z.unknown().optional(),repositories_removed:z.array(z.object({id:z.number().int().positive().safe()})).optional()});
export async function githubWebhookRoute(request:Request){
 const config=githubConfiguration();if(!config)return jsonError("GitHub webhook is unconfigured",503);
 const signature=request.headers.get("x-hub-signature-256")??"";if(!/^sha256=[a-f0-9]{64}$/.test(signature))return jsonError("Invalid webhook signature",401);
 const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
 if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1048576){await reader.cancel();return jsonError("Webhook exceeds 1 MB",413);}chunks.push(chunk.value);}
 const raw=Buffer.concat(chunks).toString("utf8");if(!await verify(config.webhookSecret,raw,signature))return jsonError("Invalid webhook signature",401);
 const delivery=request.headers.get("x-github-delivery");if(!delivery||!z.uuid().safeParse(delivery).success)return jsonError("A delivery UUID is required",400);
 const event=request.headers.get("x-github-event");if(!["pull_request","installation","installation_repositories"].includes(event??""))return Response.json({ignored:true},{status:202});
 let value:unknown;try{value=JSON.parse(raw);}catch{return jsonError("Invalid webhook JSON",400);}
 const parsed=envelope.safeParse(value);if(!parsed.success)return jsonError("Invalid webhook payload",400);const payload=parsed.data;
 if(payload.installation.id!==config.installationId)return Response.json({ignored:true},{status:202});
 const hash=createHash("sha256").update(raw).digest("hex");
 return getDb().transaction(async tx=>{
  const [connection]=await tx.select().from(githubConnections).where(and(eq(githubConnections.installationId,config.installationId),sql`lower(${githubConnections.repository}) = ${config.repository.toLowerCase()}`)).for("update");
  if(!connection||!usable(connection))return Response.json({ignored:true},{status:202});
  if(event==="pull_request"&&payload.repository?.id!==connection.repositoryId)return Response.json({ignored:true},{status:202});
  const inserted=await tx.insert(githubDeliveries).values({connectionId:connection.id,deliveryId:delivery,bodyHash:hash,event:event!}).onConflictDoNothing().returning();
  if(!inserted.length){const [old]=await tx.select().from(githubDeliveries).where(and(eq(githubDeliveries.connectionId,connection.id),eq(githubDeliveries.deliveryId,delivery)));return old.bodyHash===hash?Response.json({duplicate:true}):jsonError("Delivery id was reused with a different payload",409);}
  const revoked=event==="installation"&&["deleted","suspend"].includes(payload.action??"")||event==="installation_repositories"&&payload.repositories_removed?.some(r=>r.id===connection.repositoryId);
  if(revoked){await tx.update(githubConnections).set({status:"revoked",reason:"GitHub revoked or suspended repository access. An Admin must verify it again.",version:connection.version+1,updatedAt:new Date()}).where(eq(githubConnections.id,connection.id));await tx.update(githubPullRequests).set({completeOnMerge:false,version:sql`${githubPullRequests.version}+1`}).where(eq(githubPullRequests.connectionId,connection.id));return Response.json({revoked:true});}
  if(event!=="pull_request")return Response.json({ignored:true});
  let pr:VerifiedPullRequest;try{pr=normalizePullRequest(payload.pull_request,connection.repositoryId,connection.repository);}catch{return jsonError("Invalid pull request payload",400);}
  const links=await tx.select().from(githubPullRequests).where(and(eq(githubPullRequests.connectionId,connection.id),eq(githubPullRequests.providerId,pr.providerId),isNull(githubPullRequests.unlinkedAt))).orderBy(githubPullRequests.issueId).for("update");
  for(const link of links)await applyProvider(tx,connection,link,pr);
  return Response.json({processed:links.length});
 });
}
