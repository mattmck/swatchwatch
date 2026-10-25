"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs as TabsPrimitive } from "radix-ui";
import { AppShell } from "@/components/app-shell";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { RequireAuth } from "@/components/require-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { type AdminTab, buildAdminTabSearch, getTabFromQuery } from "@/lib/admin-tabs";
import { buildMsalConfig } from "@/lib/msal-config";
import { cn } from "@/lib/utils";
import { AdminJobsContent } from "@/app/(app)/admin/jobs/page";
import { UsersTab } from "@/app/(admin)/admin/reference-data/components/users-tab";
import { BottleEvalTab } from "./reference-data/components/bottle-eval-tab";
import { BackfillsTab } from "./reference-data/components/backfills-tab";
import { ConfigTab } from "./reference-data/components/config-tab";
import { HexLabelingTab } from "./reference-data/components/hex-labeling-tab";
import { JobsTab } from "./reference-data/components/jobs-tab";
import { ProductCategoryPanel } from "./reference-data/components/product-category-panel";
import { ReviewQueueTab } from "./reference-data/components/review-queue-tab";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

export default function AdminPage() {
  if (IS_DEV_BYPASS) {
    return <DevAdminPage />;
  }

  if (!HAS_B2C_CONFIG) {
    return <UnconfiguredAdminPage />;
  }

  return <B2CAdminPage />;
}

function DevAdminPage() {
  const { isAdmin } = useDevAuth();
  return <AdminRoute isAdmin={isAdmin} />;
}

function B2CAdminPage() {
  const { isAdmin } = useAuth();
  return <AdminRoute isAdmin={isAdmin} />;
}

function UnconfiguredAdminPage() {
  const { isAdmin } = useUnconfiguredAuth();
  return <AdminRoute isAdmin={isAdmin} />;
}

function AdminRoute({ isAdmin }: { isAdmin: boolean }) {
  return (
    <RequireAuth>
      <AppShell>
        {isAdmin ? <AdminContent /> : <AdminAccessRequired />}
      </AppShell>
    </RequireAuth>
  );
}

function AdminAccessRequired() {
  return (
    <ErrorState
      title="Admin Access Required"
      message="This page is only available to admin users."
      className="min-h-[420px]"
    />
  );
}

function AdminContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="heading-page">Admin</h1>
        <p className="text-muted-foreground">
          Manage reference configuration and monitor admin job activity from one place.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Admin Console</CardTitle>
          <CardDescription>
            Configuration manages reference data, Job Runs lists recent reference-data jobs, Admin Jobs controls ingestion, User Management searches, edits, suspends and merges user accounts, Review Queue approves, merges, or rejects user-submitted shades, Hex Labeling builds ground-truth colours for the hex-detection eval, Bottle Eval photographs labeled bottles as private samples for bottle recognition, and Backfills runs the catalog backfills in batches.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* useSearchParams() needs a Suspense boundary under `output: "export"`: the prerendered
              HTML holds the fallback and the tabs render on the client, so the active tab never
              mismatches during hydration. */}
          <Suspense fallback={<BrandSpinner label="Loading admin console…" />}>
            <AdminTabs />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminTabs() {
  const searchParams = useSearchParams();
  const activeTab = getTabFromQuery(searchParams.get("tab"));

  // Next.js syncs history.replaceState into useSearchParams(), so the URL is the tab state
  // (deep links and reloads reopen the same tab) without a router navigation.
  const selectTab = (tab: AdminTab) => {
    window.history.replaceState(null, "", buildAdminTabSearch(window.location.search, tab));
  };

  return (
    <TabsPrimitive.Root value={activeTab} onValueChange={(value) => selectTab(value as AdminTab)} className="space-y-4">
      <TabsPrimitive.List className="flex h-10 max-w-full items-center justify-start overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground sm:inline-flex sm:justify-center">
        <TabsPrimitive.Trigger
          value="configuration"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Configuration
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="job-runs"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Job Runs
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="admin-jobs"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Admin Jobs
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="users"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          User Management
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="review-queue"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Review Queue
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="hex-labeling"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Hex Labeling
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="bottle-eval"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Bottle Eval
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="backfills"
          className={cn(
            "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
            "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          )}
        >
          Backfills
        </TabsPrimitive.Trigger>
      </TabsPrimitive.List>

      <TabsPrimitive.Content value="configuration" className="outline-none">
        <ConfigTab />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="job-runs" className="outline-none">
        <JobsTab />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="admin-jobs" className="outline-none">
        <AdminJobsContent />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="users" className="outline-none">
        <UsersTab />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="review-queue" className="space-y-8 outline-none">
        <ReviewQueueTab />
        <ProductCategoryPanel />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="hex-labeling" className="outline-none">
        <HexLabelingTab />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="bottle-eval" className="outline-none">
        <BottleEvalTab />
      </TabsPrimitive.Content>

      {/* Force-mounted so a running backfill keeps looping while another tab is open. */}
      <TabsPrimitive.Content forceMount value="backfills" className="outline-none data-[state=inactive]:hidden">
        <BackfillsTab onOpenProductCategories={() => selectTab("review-queue")} />
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}
