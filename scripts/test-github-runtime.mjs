// Production native runtime with a controlled provider. No real GitHub credentials used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '@playwright/test';
import { Client } from 'pg';
import { DEMO_EMAIL } from '../.neander/seed.mjs';
import { startGitHubFixture } from './testing/github-provider-fixture.mjs';
import { testGitHubWorkflows } from './testing/github-workflows.mjs';
import { testGitHubBrowser } from './testing/github-browser.mjs';
import { testFeaturePersistence } from './testing/feature-persistence.mjs';
import { testFeatureWorkflows } from './test-feature-workflows.mjs';
const origin=process.env.BETTER_AUTH_URL;const url=new URL(origin);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(process.env.DATABASE_URL,process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);assert.ok(process.env.DATABASE_URL);
const fixture=await startGitHubFixture();const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();let child;const dir=resolve(process.env.ISSUEDESK_FEATURE_EVIDENCE||'.local/feature-runtime');await mkdir(dir,{recursive:true});
async function start(configured){const env={...process.env,PORT:url.port,HOSTNAME:'127.0.0.1',NODE_ENV:'production'};for(const key of Object.keys(fixture.env))delete env[key];delete env.NODE_OPTIONS;if(configured)Object.assign(env,fixture.env,{ISSUEDESK_TEST_GITHUB_ORIGIN:fixture.origin,NODE_OPTIONS:'--import='+resolve('scripts/testing/github-fetch-transport.mjs')});const log=await open(resolve(dir,configured?'configured-runtime.log':'unconfigured-runtime.log'),'w');child=spawn(process.execPath,['.next/standalone/server.js'],{env,stdio:['ignore',log.fd,log.fd]});await log.close();for(let n=0;n<100;n++){if(child.exitCode!==null)throw new Error('Feature runtime exited; inspect its local log');try{if((await fetch(origin+'/api/health')).ok)return;}catch{}await delay(300);}throw new Error('Runtime readiness timed out');}
async function stop(){if(!child)return;const ended=once(child,'exit');child.kill('SIGTERM');await ended;child=null;}
try{
 await db.query('DELETE FROM github_connections WHERE installation_id=$1',[fixture.installationId]);
 await start(false);const ctx=await request.newContext({baseURL:origin,extraHTTPHeaders:{origin,'x-forwarded-for':'203.0.113.96'}});assert.equal((await ctx.post('/api/auth/sign-in/email',{data:{email:DEMO_EMAIL,password:process.env.DEMO_OWNER_PASSWORD}})).status(),200);const state=await ctx.get('/api/integrations/github');assert.equal(state.status(),200);assert.equal((await state.json()).status,'unconfigured');assert.equal((await ctx.post('/api/integrations/github',{data:{version:0,shareWithWorkspace:true}})).status(),409);await ctx.dispose();await stop();console.log('Unconfigured runtime correctly rejects connection without fabricating success.');
 await start(true);await testFeatureWorkflows(origin,{afterTemplates:context=>testGitHubWorkflows(context,fixture,origin)});
 await testGitHubBrowser(origin,fixture,resolve(dir,'github-ui'));
 await testFeaturePersistence(origin,fixture,async()=>{await stop();await start(true);});
 console.log('Production native runtime feature checks passed (controlled provider; real GitHub not configured).');
}finally{await stop();await db.query('DELETE FROM github_connections WHERE installation_id=$1',[fixture.installationId]);await db.end();await fixture.close();}
