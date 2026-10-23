export const ADMIN_TABS = ["configuration", "job-runs", "admin-jobs", "users", "review-queue", "hex-labeling", "backfills"] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

export const DEFAULT_ADMIN_TAB: AdminTab = "configuration";

/** Maps the `?tab=` query value to a known admin tab, falling back to Configuration. */
export function getTabFromQuery(value: string | null): AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(value ?? "") ? (value as AdminTab) : DEFAULT_ADMIN_TAB;
}

/** Returns the `?…` search string for `tab`, keeping any other query params. */
export function buildAdminTabSearch(currentSearch: string, tab: AdminTab): string {
  const params = new URLSearchParams(currentSearch);
  params.set("tab", tab);
  return `?${params.toString()}`;
}
