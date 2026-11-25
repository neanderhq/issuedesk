// Controlled HTTP provider for production-runtime tests. Not imported by application code.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, verify as verifySignature } from 'node:crypto';
export async function startGitHubFixture(){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const appId='123456',installationId=456789,repositoryId=987654,repository='fictional-owner/launch-work';
 const token='fictional-installation-'+randomUUID();const webhookSecret=randomUUID()+randomUUID();const prs=new Map();let mode='ok',clock=Date.now(),calls=0,authorized=0;
 const repo={id:repositoryId,full_name:repository,default_branch:'main',private:true};
 function pull(number,values={}){const old=prs.get(number);const pr={id:900000+number,number,title:'Fictional accessibility review '+number,state:'open',draft:false,merged:false,merged_at:null,updated_at:new Date(++clock).toISOString(),base:{ref:'main',repo},...old,...values};if(!values.updated_at)pr.updated_at=new Date(++clock).toISOString();prs.set(number,pr);return pr;}
 pull(1);pull(2,{draft:true});pull(3,{state:'closed'});pull(4,{state:'closed',merged:true,merged_at:new Date(clock).toISOString()});
 const server=createServer(async(req,res)=>{calls++;try{
  const auth=req.headers.authorization??'';const path=new URL(req.url,'http://fixture').pathname;let data='';for await(const chunk of req)data+=chunk;
  const send=(status,payload,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(payload));};
  if(mode==='stale')return send(503,{message:'Controlled unavailable'});
  if(mode==='revoked')return send(403,{message:'Controlled access revoked'});
  if(mode==='limited')return send(403,{message:'Controlled rate limit'},{'x-ratelimit-remaining':'0'});
  if(path.endsWith('/installation')||path.includes('/access_tokens')){
   const jwt=auth.replace(/^Bearer /i,'').split('.');assert.equal(jwt.length,3);assert.ok(verifySignature('RSA-SHA256',Buffer.from(jwt[0]+'.'+jwt[1]),publicKey,Buffer.from(jwt[2],'base64url')));const payload=JSON.parse(Buffer.from(jwt[1],'base64url'));assert.equal(String(payload.iss),appId);assert.ok(payload.exp>Date.now()/1000);authorized++;
   if(path===`/repos/${repository}/installation`){assert.equal(req.method,'GET');return send(200,{id:installationId,suspended_at:null,permissions:{metadata:'read',pull_requests:'read'}});}
   assert.equal(path,`/app/installations/${installationId}/access_tokens`);assert.equal(req.method,'POST');const scope=JSON.parse(data);assert.deepEqual(scope.repositories,['launch-work']);assert.equal(scope.permissions.pull_requests,'read');assert.equal(scope.permissions.metadata,'read');return send(201,{token,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:scope.permissions,repository_selection:'selected',repositories:[repo]});
  }
  assert.equal(auth,`Bearer ${token}`);assert.equal(req.method,'GET');authorized++;
  if(path===`/repos/${repository}`)return send(200,repo);
  const match=path.match(new RegExp('^/repos/'+repository+'/pulls/(\\d+)$'));if(match&&prs.has(Number(match[1])))return send(200,prs.get(Number(match[1])));
  return send(404,{message:'Controlled missing'});
 }catch(error){console.error('Controlled GitHub contract assertion failed:',error.message);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({message:'Controlled provider contract failure'}));}});
 await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));const port=server.address().port;
 return {port,origin:`http://127.0.0.1:${port}`,repositoryId,installationId,repository,webhookSecret,pull,setMode:value=>{mode=value;},stats:()=>({calls,authorized}),env:{GITHUB_APP_ID:appId,GITHUB_APP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}).replaceAll('\n','\\n'),GITHUB_INSTALLATION_ID:String(installationId),GITHUB_REPOSITORY:repository,GITHUB_WEBHOOK_SECRET:webhookSecret},close:()=>new Promise(resolve=>server.close(resolve))};
}
