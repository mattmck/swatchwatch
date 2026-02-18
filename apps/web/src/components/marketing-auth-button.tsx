"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAuth, useDevAuth } from "@/hooks/use-auth";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

export function MarketingAuthButton() {
  if (IS_DEV_BYPASS) {
    return <DevButton />;
  }
  return <B2CButton />;
}

function DevButton() {
  useDevAuth(); // consistent hook call
  return (
    <Button asChild variant="brand">
      <Link href="/dashboard">Open App</Link>
    </Button>
  );
}

function B2CButton() {
  const { isAuthenticated, login } = useAuth();

  if (isAuthenticated) {
    return (
      <Button asChild variant="brand">
        <Link href="/dashboard">Open App</Link>
      </Button>
    );
  }

  return (
    <Button variant="brand" onClick={login}>
      Sign In
    </Button>
  );
}
