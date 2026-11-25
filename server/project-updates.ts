import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { jsonError, requireWorkspaceAccess, validateMutationAndParse } from "./http";
import { projectUpdateRevisions, projectUpdates, projects } from "./schema";
import { multilineTextInput } from "./validation";
type Access = Extract<Awaited<ReturnType<typeof requireWorkspaceAccess>>, { membership: unknown }>;
const fields = z.object({ health: z.enum(["On track", "At risk", "Off track"]), body: multilineTextInput(20000).min(1,"Write a project update before publishing.") }).strict();
const version = z.object({ version: z.number().int().positive() }).strict();
const edit = fields.extend({ version: z.number().int().positive() });
export async function projectUpdatesRoute(request: Request, access: Access, projectId: string, updateId?: string) {
  if(!z.uuid().safeParse(projectId).success || (updateId&&!z.uuid().safeParse(updateId).success))return jsonError("Project/update id is invalid",400);
  const db=getDb();const workspaceId=access.membership.workspaceId;
  const projectWhere=and(eq(projects.id,projectId),eq(projects.workspaceId,workspaceId));
  const [project]=await db.select({id:projects.id,archivedAt:projects.archivedAt}).from(projects).where(projectWhere);
  if(!project)return jsonError("Project not found",404);
  if(request.method==="GET"&&!updateId){
    const rows=await db.select().from(projectUpdates).where(and(eq(projectUpdates.workspaceId,workspaceId),eq(projectUpdates.projectId,projectId))).orderBy(desc(projectUpdates.createdAt),desc(projectUpdates.id));
    const revisions=rows.length?await db.select().from(projectUpdateRevisions).where(and(eq(projectUpdateRevisions.workspaceId,workspaceId),inArray(projectUpdateRevisions.updateId,rows.map(r=>r.id)))).orderBy(desc(projectUpdateRevisions.version)):[];
    const updates=rows.map(row=>({...row,canEdit:!project.archivedAt&&!row.withdrawnAt&&(access.membership.role==="Admin"||row.authorId===access.session.user.id),revisions:revisions.filter(r=>r.updateId===row.id&&r.version<=row.version)}));
    return Response.json({updates,latestId:updates.find(r=>!r.withdrawnAt)?.id??null,canPublish:!project.archivedAt});
  }
  if((!updateId&&request.method!=="POST")||(updateId&&!["PATCH","DELETE"].includes(request.method)))return jsonError("Method not allowed",405);
  const parsed=await validateMutationAndParse(request,request.method==="DELETE"?version:request.method==="PATCH"?edit:fields);if("response"in parsed)return parsed.response;
  return db.transaction(async tx=>{
    const [lockedProject]=await tx.select().from(projects).where(projectWhere).for("update");
    if(!lockedProject)return jsonError("Project not found",404);if(lockedProject.archivedAt)return jsonError("Archived projects are read-only. Restore the project to publish updates.",409);
    let row:typeof projectUpdates.$inferSelect;let action="published";
    if(!updateId){
      const data=fields.parse(parsed.data);[row]=await tx.insert(projectUpdates).values({workspaceId,projectId,authorId:access.session.user.id,authorName:access.session.user.name,...data}).returning();
    }else{
      const [current]=await tx.select().from(projectUpdates).where(and(eq(projectUpdates.id,updateId),eq(projectUpdates.workspaceId,workspaceId),eq(projectUpdates.projectId,projectId))).for("update");
      if(!current)return jsonError("Project update not found",404);
      if(access.membership.role!=="Admin"&&current.authorId!==access.session.user.id)return jsonError("Only the author or an Admin may change this update",403);
      if(current.withdrawnAt)return jsonError("Withdrawn updates are read-only",409);
      const currentVersion=version.parse({version:(parsed.data as {version:number}).version}).version;
      if(current.version!==currentVersion)return Response.json({error:"Someone else changed this update. Your draft is kept; review the latest version before retrying.",current},{status:409});
      action=request.method==="DELETE"?"withdrawn":"edited";
      const edited=request.method==="PATCH"?edit.parse(parsed.data):null;
      const values=edited?{health:edited.health,body:edited.body}:{withdrawnAt:new Date()};
      [row]=await tx.update(projectUpdates).set({...values,version:current.version+1,updatedAt:new Date()}).where(eq(projectUpdates.id,current.id)).returning();
    }
    await tx.insert(projectUpdateRevisions).values({workspaceId,updateId:row.id,version:row.version,health:row.health,body:row.body,actorId:access.session.user.id,actorName:access.session.user.name,action});
    return Response.json(row,{status:request.method==="POST"?201:200});
  });
}
