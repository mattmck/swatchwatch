"use client";

import { useEffect, useState } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/error-state";
import { RequireAuth } from "@/components/require-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { buildMsalConfig } from "@/lib/msal-config";
import { cn } from "@/lib/utils";
import { AdminJobsContent } from "@/app/(app)/admin/jobs/page";
import { ConfigTab } from "./reference-data/components/config-tab";
import { JobsTab } from "./reference-data/components/jobs-tab";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

type AdminTab = "configuration" | "job-runs" | "admin-jobs";

function getTabFromQuery(value: string | null): AdminTab {
  if (value === "configuration" || value === "job-runs" || value === "admin-jobs") {
    return value;
  }
  return "configuration";
}

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
  const [activeTab, setActiveTab] = useState<AdminTab>("configuration");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tab = getTabFromQuery(params.get("tab"));
    setActiveTab(tab);
  }, []);

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
            Configuration manages reference data, Job Runs lists recent reference-data jobs, and Admin Jobs controls ingestion.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TabsPrimitive.Root value={activeTab} onValueChange={(value) => setActiveTab(value as AdminTab)} className="space-y-4">
            <TabsPrimitive.List className="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
              <TabsPrimitive.Trigger
                value="configuration"
                className={cn(
                  "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                )}
              >
                Configuration
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger
                value="job-runs"
                className={cn(
                  "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                )}
              >
                Job Runs
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger
                value="admin-jobs"
                className={cn(
                  "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                )}
              >
                Admin Jobs
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
          </TabsPrimitive.Root>
        </CardContent>
      </Card>
    </div>
  );
}
