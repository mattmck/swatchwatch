"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, useDevAuth } from "@/hooks/use-auth";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function UserCard() {
  if (IS_DEV_BYPASS) {
    return <DevUserCard />;
  }
  return <B2CUserCard />;
}

function DevUserCard() {
  const { user } = useDevAuth();
  return <UserCardInner name={user?.name ?? "Dev"} email={user?.email} />;
}

function B2CUserCard() {
  const { user, logout, isAuthenticated } = useAuth();

  if (!isAuthenticated || !user) {
    return null;
  }

  return (
    <UserCardInner name={user.name} email={user.email} onSignOut={logout} />
  );
}

function UserCardInner({
  name,
  email,
  onSignOut,
}: {
  name: string;
  email?: string;
  onSignOut?: () => void;
}) {
  return (
    <div className="rounded-xl border border-brand-purple/20 bg-card/80 p-3 shadow-[0_10px_24px_rgba(66,16,126,0.1)]">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-gradient-brand text-xs font-semibold text-white shadow-glow-brand">
          {getInitials(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {name}
          </p>
          {email && (
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          )}
        </div>
      </div>
      {onSignOut && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full justify-start"
          onClick={onSignOut}
        >
          <LogOut className="size-3.5" />
          Sign Out
        </Button>
      )}
    </div>
  );
}
