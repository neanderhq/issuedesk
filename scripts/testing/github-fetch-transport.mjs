// Test-only preload: exercise the maintained SDK against a controlled HTTP server.
// This file is neither imported by app code nor included in the site bundle.
const target=new URL(process.env.ISSUEDESK_TEST_GITHUB_ORIGIN);
if(target.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal'].includes(target.hostname))throw new Error('Controlled GitHub transport requires a local fixture');
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const source=new URL(input instanceof Request?input.url:String(input));
 if(source.hostname==='api.github.com'){
  source.protocol=target.protocol;source.host=target.host;
  return original(input instanceof Request?new Request(source,input):source,init);
 }
 return original(input,init);
};
