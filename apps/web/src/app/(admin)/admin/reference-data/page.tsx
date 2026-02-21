"use client";

import { useState } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/error-state";
import { RequireAuth } from "@/components/require-auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { buildMsalConfig } from "@/lib/msal-config";
import { cn } from "@/lib/utils";
import { ConfigTab } from "./components/config-tab";
import { JobsTab } from "./components/jobs-tab";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

export default function AdminReferenceDataPage() {
  if (IS_DEV_BYPASS) {
    return <DevAdminReferenceDataPage />;
  }

  if (!HAS_B2C_CONFIG) {
    return <UnconfiguredAdminReferenceDataPage />;
  }

  return <B2CAdminReferenceDataPage />;
}

function DevAdminReferenceDataPage() {
  const { isAdmin } = useDevAuth();
  return <AdminReferenceDataRoute isAdmin={isAdmin} />;
}

function B2CAdminReferenceDataPage() {
  const { isAdmin } = useAuth();
  return <AdminReferenceDataRoute isAdmin={isAdmin} />;
}

function UnconfiguredAdminReferenceDataPage() {
  const { isAdmin } = useUnconfiguredAuth();
  return <AdminReferenceDataRoute isAdmin={isAdmin} />;
}

function AdminReferenceDataRoute({ isAdmin }: { isAdmin: boolean }) {
  return (
    <RequireAuth>
      <AppShell>
        {isAdmin ? <AdminReferenceDataContent /> : <AdminAccessRequired />}
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

function AdminReferenceDataContent() {
  const [activeTab, setActiveTab] = useState("jobs");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="heading-page">Reference Data Admin</h1>
        <p className="text-muted-foreground">
          Monitor admin jobs and manage reference types used across the app.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Admin Console</CardTitle>
          <CardDescription>
            Use Jobs to inspect processing history and Configuration to manage finish and harmony taxonomies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TabsPrimitive.Root value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <TabsPrimitive.List className="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
              <TabsPrimitive.Trigger
                value="jobs"
                className={cn(
                  "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                )}
              >
                Jobs
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger
                value="configuration"
                className={cn(
                  "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                )}
              >
                Configuration
              </TabsPrimitive.Trigger>
            </TabsPrimitive.List>

            <TabsPrimitive.Content value="jobs" className="outline-none">
              <JobsTab />
            </TabsPrimitive.Content>
            <TabsPrimitive.Content value="configuration" className="outline-none">
              <ConfigTab />
            </TabsPrimitive.Content>
          </TabsPrimitive.Root>
        </CardContent>
      </Card>
    </div>
  );
}
