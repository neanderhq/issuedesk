"use client";

import { useEffect, useRef } from "react";
import { redirectToLoginForUnauthorized } from "@/components/issues/issue-api";

type ChangeResponse = { cursor: string };

export function useLiveUpdates(onChange: () => void | Promise<void>) {
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cursor: string | null = null;
    let checking = false;
    let active = true;

    async function checkForChanges() {
      if (!active || document.hidden || checking) return;
      checking = true;
      try {
        const response = await fetch("/api/changes", { cache: "no-store" });
        if (!response.ok) {
          redirectToLoginForUnauthorized(response.status, "/api/changes");
          return;
        }
        const current = await response.json() as ChangeResponse;
        if (cursor === null) cursor = current.cursor;
        else if (cursor !== current.cursor) {
          cursor = current.cursor;
          await onChangeRef.current();
        }
      } catch {
        return;
      } finally {
        checking = false;
      }
    }

    const interval = window.setInterval(() => { void checkForChanges(); }, 3000);
    const handleVisibilityChange = () => {
      if (!document.hidden) void checkForChanges();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void checkForChanges();

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
