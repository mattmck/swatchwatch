import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/components/require-auth";

export const metadata: Metadata = {
  title: "Rapid Add",
};

/**
 * Rapid Add sits outside the `(app)` route group (its URL predates the groups) but needs
 * the same signed-in shell: every action calls the authenticated capture API.
 */
export default function RapidAddLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
