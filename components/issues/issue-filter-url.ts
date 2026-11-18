export const clearedSavedViewFiltersKey = "viewFilters";

export function hasExplicitlyClearedSavedViewFilters(search: URLSearchParams, persistClearedFilters: boolean) {
  return persistClearedFilters && search.get(clearedSavedViewFiltersKey) === "cleared";
}

export function writeIssueFiltersToSearch(
  search: URLSearchParams,
  filterKeys: readonly string[],
  filters: URLSearchParams,
  persistClearedFilters: boolean,
) {
  for (const key of filterKeys) search.delete(key);
  search.delete(clearedSavedViewFiltersKey);
  for (const [key, value] of filters) search.set(key, value);
  if (persistClearedFilters && filters.size === 0) search.set(clearedSavedViewFiltersKey, "cleared");
}
