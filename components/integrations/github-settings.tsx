"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { requestJson } from "@/components/issues/issue-api";
import type { GitHubConnection } from "@/components/issues/github-pull-request";
import { Button } from "@/components/ui/button";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";
import { formatDateTime } from "@/lib/date-format";
type State={configured:boolean;status:string;connection:GitHubConnection|null;canManage:boolean;offeredRepository:string|null};
export function GitHubSettings(){
 const [data,setData]=useState<State|null>(null);const [consent,setConsent]=useState(false);const [confirm,setConfirm]=useState(false);const [saving,setSaving]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");const errorRef=useRef<HTMLParagraphElement>(null);const opener=useRef<HTMLButtonElement>(null);
 const load=useCallback(async()=>{try{setData(await requestJson<State>("/api/integrations/github"));}catch(e){setError(e instanceof Error?e.message:"Could not load GitHub settings.");}},[]);useEffect(()=>{void load();},[load]);useLiveUpdates(load);useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
 async function mutate(method:string){setSaving(true);setError("");setNotice("");try{await requestJson("/api/integrations/github",{method,headers:{"Content-Type":"application/json"},body:JSON.stringify({version:data?.connection?.version??0,...(method==="POST"?{shareWithWorkspace:true}:{})})});setConfirm(false);setConsent(false);setNotice(method==="DELETE"?"Disconnected. Completion automation is disabled.":"Repository access verified. Link a pull request from an issue.");await load();}catch(e){setError(e instanceof Error?e.message:"GitHub action failed.");await load();}finally{setSaving(false);}}
 return <section className="grid min-w-0 max-w-2xl gap-4"><h1 className="text-2xl font-semibold">GitHub integration</h1><p className="text-sm text-muted-foreground">Link pull requests to issues. Members choose whether a merged pull request completes an issue. IssueDesk never writes to GitHub.</p>
 {error&&<p ref={errorRef} tabIndex={-1} role="alert" className="break-words text-sm text-destructive">{error}</p>}{notice&&<p role="status" className="text-sm">{notice}</p>}
 {!data?<p>Loading connection…</p>:<div className="grid min-w-0 gap-4 rounded-lg border bg-card p-4"><p className="font-medium">{data.status==="unconfigured"?"Unconfigured":data.status.replaceAll('_',' ')}</p>{data.connection&&<><p className="break-words [overflow-wrap:anywhere]">Repository: {data.connection.repository}</p><p className="text-xs text-muted-foreground">Last verified {formatDateTime(data.connection.lastVerifiedAt)}</p></>}{data.connection?.reason&&<p className="text-sm">{data.connection.reason}</p>}
 {!data.configured&&<p className="text-sm text-muted-foreground">An operator must configure a GitHub App installation, repository and webhook secret on the IssueDesk server. No credentials are entered in this workspace.</p>}
 {!data.canManage?<p className="text-sm text-muted-foreground">An Admin manages this connection. Members can link pull requests after it is verified.</p>:<>
 {data.offeredRepository&&<p className="break-words text-sm [overflow-wrap:anywhere]">Operator-configured repository: {data.offeredRepository}</p>}
 {data.configured&&<form className="grid gap-3" onSubmit={(e:FormEvent)=>{e.preventDefault();void mutate("POST");}}><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" required checked={consent} disabled={saving} onChange={e=>setConsent(e.target.checked)}/><span>I allow all members of this workspace to see linked pull request titles, states, URLs and target branches from the operator-configured repository.</span></label><Button type="submit" className="w-fit" disabled={!consent||saving}>{saving?"Verifying…":"Verify and connect repository"}</Button></form>}
 {data.connection&&data.status!=="disconnected"&&<Button ref={opener} className="w-fit" variant="outline" disabled={saving} onClick={()=>setConfirm(true)}>Disconnect GitHub</Button>}
 {confirm&&<div role="group" aria-label="Confirm GitHub disconnect" className="grid gap-2 rounded-md border p-3"><p className="text-sm">Disconnect GitHub? Existing metadata and audit history stay saved. All completion opt-ins are disabled and must be selected again after reconnection.</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={saving} onClick={()=>{setConfirm(false);opener.current?.focus();}}>Keep connection</Button><Button variant="destructive" disabled={saving} onClick={()=>void mutate("DELETE")}>Disconnect now</Button></div></div>}
 </>}
 </div>}
 </section>;
}
