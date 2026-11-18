"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, CircleDot, Plus, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AttioCard, AttioGrid, AttioPage, AttioSection, AttioStack } from "@/src/neander-design-pack/attio/2.0.0/AttioLayouts";
import { ApiError, requestJson } from "@/components/issues/issue-api";
import { addDays, cycleRange, dateValue, type CycleRecord, type CycleStatus } from "./cycle-api";
import { useLiveUpdates } from "@/components/live-updates/use-live-updates";

type CycleDraft = { name: string; goal: string; startDate: string; endDate: string };

const initialDraft = (cycles: CycleRecord[] = []): CycleDraft => {
  const latestEndDate = cycles.reduce((latest, cycle) => cycle.endDate > latest ? cycle.endDate : latest, "");
  const startDate = latestEndDate ? addDays(latestEndDate, 1) : dateValue();
  return { name: "", goal: "", startDate, endDate: addDays(startDate, 13) };
};

function CycleCard({ cycle }: { cycle: CycleRecord }) {
  return <Link href={`/cycles/${encodeURIComponent(cycle.id)}`} className="block min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Card className="h-full transition-colors hover:bg-muted/30">
      <CardContent className="grid min-w-0 gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3"><span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><CircleDot className="size-4" /></span><div className="min-w-0"><h3 className="break-words text-base font-semibold">{cycle.name}</h3><p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays className="size-3.5" />{cycleRange(cycle)}</p></div></div>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium">{cycle.status}</span>
        </div>
        <p className="min-h-10 break-words text-sm text-muted-foreground">{cycle.goal || "No goal added yet."}</p>
        <span className="text-sm font-medium text-primary">Open cycle <span aria-hidden="true">→</span></span>
      </CardContent>
    </Card>
  </Link>;
}

export function CyclesListPage() {
  const [cycles, setCycles] = useState<CycleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CycleDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const result = await requestJson<{ cycles: CycleRecord[] }>("/api/cycles");
      setCycles(result.cycles);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Cycles could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useLiveUpdates(load);

  useEffect(() => { void load(); }, [load]);

  async function createCycle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      const created = await requestJson<CycleRecord>("/api/cycles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft.name.trim() || undefined, goal: draft.goal.trim() || null, startDate: draft.startDate, endDate: draft.endDate }),
      });
      setCreateOpen(false);
      setDraft(initialDraft([...cycles, created]));
      await load();
      window.location.assign(`/cycles/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      setSaveError(cause instanceof ApiError && cause.status === 409
        ? "Those dates overlap another cycle. Choose a different date range."
        : cause instanceof Error ? cause.message : "The cycle could not be created.");
    } finally {
      setSaving(false);
    }
  }

  const groups: Array<{ status: CycleStatus; cycles: CycleRecord[] }> = [
    { status: "Active", cycles: cycles.filter((cycle) => cycle.status === "Active") },
    { status: "Upcoming", cycles: cycles.filter((cycle) => cycle.status === "Upcoming").sort((a, b) => a.startDate.localeCompare(b.startDate)) },
    { status: "Completed", cycles: cycles.filter((cycle) => cycle.status === "Completed").sort((a, b) => b.endDate.localeCompare(a.endDate)) },
  ];

  return <AttioPage title="Cycles" description="Plan work into focused, time-boxed cycles." width="wide" actions={<Button type="button" disabled={loading || Boolean(loadError)} onClick={() => { setDraft(initialDraft(cycles)); setSaveError(""); setCreateOpen(true); }}><Plus />New cycle</Button>}>
    <AttioStack>
      {loadError && <Alert variant="destructive"><AlertTitle>Could not load cycles</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{loadError}<Button type="button" size="sm" variant="outline" onClick={() => { setLoading(true); void load(); }}><RotateCw />Try again</Button></AlertDescription></Alert>}
      {groups.map(({ status, cycles: grouped }) => <AttioSection key={status} title={status} description={status === "Active" ? "Work in progress now." : status === "Upcoming" ? "Cycles ready for planning." : "A record of finished cycles."}>
        {loading ? <AttioGrid columns={2}>{[0, 1].map((item) => <Skeleton key={item} className="h-40 w-full rounded-lg" />)}</AttioGrid> : grouped.length ? <AttioGrid columns={2}>{grouped.map((cycle) => <CycleCard key={cycle.id} cycle={cycle} />)}</AttioGrid> : <AttioCard padding={4}><div className="rounded-lg border border-dashed px-4 py-8 text-center"><p className="text-sm font-medium">No {status.toLowerCase()} cycles</p><p className="mt-1 text-sm text-muted-foreground">{status === "Upcoming" ? "Create a cycle to start planning your team’s work." : status === "Active" ? "Start an upcoming cycle when your team is ready." : "Completed cycles will stay here for reference."}</p></div></AttioCard>}
      </AttioSection>)}
    </AttioStack>

    <Dialog open={createOpen} onOpenChange={(open) => { if (!saving) setCreateOpen(open); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>New cycle</DialogTitle><DialogDescription>Choose a name and date range. The default length is two weeks; dates can be adjusted.</DialogDescription></DialogHeader>
        <form id="create-cycle-form" onSubmit={(event) => void createCycle(event)} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="cycle-name">Name</Label><Input id="cycle-name" maxLength={120} placeholder="Cycle name (optional)" value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
          <div className="grid gap-2"><Label htmlFor="cycle-goal">Goal</Label><Textarea id="cycle-goal" maxLength={4000} value={draft.goal} disabled={saving} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} placeholder="What should the team accomplish?" /></div>
          <div className="grid gap-3 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="cycle-start">Start date</Label><Input id="cycle-start" type="date" required value={draft.startDate} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value, endDate: current.endDate === addDays(current.startDate, 13) ? addDays(event.target.value, 13) : current.endDate }))} /></div><div className="grid gap-2"><Label htmlFor="cycle-end">End date</Label><Input id="cycle-end" type="date" required min={draft.startDate} value={draft.endDate} disabled={saving} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} /></div></div>
          {saveError && <Alert variant="destructive"><AlertTitle>Cycle not created</AlertTitle><AlertDescription>{saveError}</AlertDescription></Alert>}
        </form>
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" form="create-cycle-form" disabled={saving || !draft.startDate || !draft.endDate || draft.startDate > draft.endDate}>{saving ? "Creating…" : "Create cycle"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </AttioPage>;
}
