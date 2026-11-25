// Real authenticated HTTP + PostgreSQL regressions against an explicitly disposable built app.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { request } from '@playwright/test';
import { Client } from 'pg';
import { DEMO_EMAIL } from '../.neander/seed.mjs';

export async function testFeatureWorkflows(origin, options = {}) {
  const url=new URL(origin);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(url.protocol,'http:');assert.ok(process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);assert.equal(process.env.DATABASE_URL,process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);
  const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
  const prefix='Feature regression '+randomUUID();const users=[],invitations=[],templates=[],projects=[],issues=[],labels=[];const contexts=[];let foreignWorkspace;
  const context=async()=>{const c=await request.newContext({baseURL:origin,extraHTTPHeaders:{origin,'x-forwarded-for':'203.0.113.94'}});contexts.push(c);return c;};
  let checks=0;
  async function api(ctx,path,method='GET',data,status=200){const r=await ctx.fetch(path,{method,...(data===undefined?{}:{data})});const text=await r.text();assert.equal(r.status(),status,`${method} ${path}: ${text}`);checks++;return text?JSON.parse(text):null;}
  const admin=await context(),member=await context(),other=await context(),foreign=await context(),anon=await context();
  async function invite(ctx,name){const password='Fictional-'+randomUUID()+'-Aa9';const email='features-'+randomUUID()+'@example.invalid';const invited=await api(admin,'/api/settings/invitations','POST',{email,role:'Member'},201);invitations.push(invited.invitation.id);const token=new URL(invited.inviteUrl).searchParams.get('token');const result=await api(ctx,'/api/signup','POST',{name,email,password,invitationToken:token});users.push(result.user.id);return result.user.id;}
  try {
    await api(admin,'/api/auth/sign-in/email','POST',{email:DEMO_EMAIL,password:process.env.DEMO_OWNER_PASSWORD});
    const me=await api(admin,'/api/me');const memberId=await invite(member,'Fictional Reporter');await invite(other,'Fictional Teammate');const foreignId=await invite(foreign,'Fictional Outside Member');
    foreignWorkspace=randomUUID();await db.query('INSERT INTO workspaces (id,name) VALUES ($1,$2)',[foreignWorkspace,prefix+' outside']);await db.query('UPDATE memberships SET workspace_id=$1 WHERE user_id=$2',[foreignWorkspace,foreignId]);
    const project=await api(admin,'/api/projects','POST',{name:prefix+' launch'},201);projects.push(project.id);
    const label=await api(admin,'/api/labels','POST',{name:prefix+' bug',color:'#3366ff'},201);labels.push(label.id);
    const values={name:prefix+' template',title:'Review readiness',description:'## Expected\n\n## Steps to reproduce',priority:'High',projectId:project.id,labelIds:[label.id]};
    await api(anon,'/api/issue-templates','GET',undefined,401);
    await api(member,'/api/issue-templates','POST',values,403);
    await api(admin,'/api/issue-templates','POST',{...values,name:' '},400);
    await api(admin,'/api/issue-templates','POST',{...values,projectId:randomUUID()},400);
    await api(admin,'/api/issue-templates','POST',{...values,labelIds:[randomUUID()]},400);
    let template=await api(admin,'/api/issue-templates','POST',values,201);templates.push(template.id);
    await api(admin,'/api/issue-templates','POST',{...values,name:values.name.toUpperCase()},409);
    const applied=await api(member,`/api/issue-templates/${template.id}/apply`);assert.equal(applied.description,values.description);assert.deepEqual(applied.labelIds,[label.id]);
    assert.ok((await api(member,'/api/issue-templates')).templates.some(t=>t.id===template.id));
    await api(foreign,`/api/issue-templates/${template.id}`,'GET',undefined,404);await api(foreign,`/api/issue-templates/${template.id}/apply`,'GET',undefined,404);
    await api(member,`/api/issue-templates/${template.id}`,'PATCH',{...values,version:1},403);
    await api(foreign,`/api/issue-templates/${template.id}`,'DELETE',{version:1},403);
    const issue=await api(member,'/api/issues','POST',{title:applied.title,description:applied.description,priority:applied.priority,projectId:applied.projectId,labelIds:applied.labelIds},201);issues.push(issue.id);
    template=await api(admin,`/api/issue-templates/${template.id}`,'PATCH',{...values,title:'Updated prompt',version:template.version});
    const conflict=await api(admin,`/api/issue-templates/${template.id}`,'PATCH',{...values,title:'Stale draft',version:1},409);assert.equal(conflict.current.title,'Updated prompt');
    await api(admin,`/api/issue-templates/${template.id}`,'DELETE',{version:1},409);
    assert.equal((await api(member,`/api/issue-templates/${template.id}/apply`)).title,'Updated prompt');
    await api(admin,`/api/labels/${label.id}`,'DELETE',{});
    await api(member,`/api/issue-templates/${template.id}/apply`,'GET',undefined,409);
    assert.ok((await api(admin,'/api/issue-templates')).templates.find(t=>t.id===template.id).defaultsError);
    template=await api(admin,`/api/issue-templates/${template.id}`,'PATCH',{...values,labelIds:[],version:template.version});
    await api(admin,`/api/issue-templates/${template.id}`,'DELETE',{version:template.version});
    await api(member,`/api/issue-templates/${template.id}/apply`,'GET',undefined,404);
    const persisted=await api(member,`/api/issues/${issue.id}`);assert.equal(persisted.title,values.title);assert.equal(persisted.description,values.description);assert.equal(persisted.projectId,project.id);
    const ownIssueCount=(await db.query('SELECT count(*)::int AS n FROM issues WHERE id=$1',[issue.id])).rows[0].n;assert.equal(ownIssueCount,1);
    console.log('Templates passed: persisted defaults/application, independent issues, invalid/deleted references, optimistic conflicts, role/tenant checks.');
    if(options.afterTemplates) await options.afterTemplates({api,admin,member,other,foreign,anon,db,me,memberId,project,issues,prefix});
    console.log(`Feature HTTP assertions passed: ${checks}.`);
    return {checks};
  } finally {
    for(const id of templates)await db.query('DELETE FROM issue_templates WHERE id=$1',[id]);
    for(const id of issues)await db.query('DELETE FROM issues WHERE id=$1',[id]);
    for(const id of projects)await db.query('DELETE FROM projects WHERE id=$1',[id]);
    for(const id of labels)await db.query('DELETE FROM labels WHERE id=$1',[id]);
    for(const id of invitations)await db.query('DELETE FROM invitations WHERE id=$1',[id]);
    for(const id of users)await db.query('DELETE FROM "user" WHERE id=$1',[id]);
    if(foreignWorkspace)await db.query('DELETE FROM workspaces WHERE id=$1',[foreignWorkspace]);
    await Promise.all(contexts.map(c=>c.dispose()));await db.end();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await testFeatureWorkflows(process.argv[2]||process.env.BETTER_AUTH_URL);
