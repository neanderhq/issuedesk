"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, requestJson } from "./issue-api";
import { IssueBoardPage } from "./issue-board";
import { IssueListPage } from "./issue-list";
import type { SavedViewRecord } from "./issue-view-controls";

export function SavedIssueView({ viewId, userId }: { viewId: string; userId: string }) {
  const [savedView, setSavedView] = useState<SavedViewRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const view = await requestJson<SavedViewRecord>(`/api/saved-views/${encodeURIComponent(viewId)}`);
      setSavedView(view);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "This saved view could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [viewId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <section className="mx-auto w-full min-w-0 max-w-7xl px-3 py-6 sm:px-6"><Skeleton className="mb-4 h-24 w-full" /><Skeleton className="h-64 w-full" /></section>;
  if (!savedView) return <main className="mx-auto grid w-full min-w-0 max-w-3xl gap-4 px-3 py-6 sm:px-6"><Alert variant="destructive"><AlertCircle /><AlertTitle>Saved view unavailable</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{error || "This saved view is no longer available."}<Button size="xs" variant="outline" onClick={() => { void load(); }}><RotateCw />Try again</Button></AlertDescription></Alert></main>;

  const canManage = savedView.ownerId === userId;
  const onSavedViewChange = (updated: SavedViewRecord | null) => setSavedView(updated);
  return savedView.layout === "Board"
    ? <IssueBoardPage savedView={savedView} canManageSavedView={canManage} onSavedViewChange={onSavedViewChange} />
    : <IssueListPage view="list" userId={userId} savedView={savedView} canManageSavedView={canManage} onSavedViewChange={onSavedViewChange} />;
}
