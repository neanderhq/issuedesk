"use client";

import { useCallback, useEffect, useState } from "react";
import { issueFiltersFromSearch, issueFiltersToSearch, normalizeIssueFilters, type IssueFilters } from "./issue-filters";
import { hasExplicitlyClearedSavedViewFilters, writeIssueFiltersToSearch } from "./issue-filter-url";

const keys = ["q", "projectId", "status", "priority", "assigneeId", "labelId", "cycleId"] as const;
const emptyFilters: IssueFilters = {};

export function useIssueFilters(initialFilters: IssueFilters = emptyFilters, persistClearedFilters = false) {
  const [filters, setFiltersState] = useState<IssueFilters>(() => normalizeIssueFilters(initialFilters));

  useEffect(() => {
    const readLocation = () => {
      const search = new URLSearchParams(window.location.search);
      const hasUrlFilters = keys.some((key) => search.has(key));
      const explicitlyCleared = hasExplicitlyClearedSavedViewFilters(search, persistClearedFilters);
      setFiltersState(explicitlyCleared ? {} : hasUrlFilters ? issueFiltersFromSearch(search) : normalizeIssueFilters(initialFilters));
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [initialFilters, persistClearedFilters]);

  const setFilters = useCallback((next: IssueFilters) => {
    const normalized = normalizeIssueFilters(next);
    setFiltersState(normalized);
    const search = new URLSearchParams(window.location.search);
    writeIssueFiltersToSearch(search, keys, issueFiltersToSearch(normalized), persistClearedFilters);
    const query = search.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [persistClearedFilters]);

  return [filters, setFilters] as const;
}
