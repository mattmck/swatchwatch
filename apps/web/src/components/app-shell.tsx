"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Sparkles, Search, PlusCircle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SwatchWatchWordmark } from "@/components/brand/swatchwatch-brand";
import { ThemeToggle } from "@/components/marketing-theme-toggle";
import { UserCard } from "@/components/user-card";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/polishes", label: "Polishes", icon: Sparkles },
  { href: "/polishes/search", label: "Search", icon: Search },
  { href: "/polishes/new", label: "Add Polish", icon: PlusCircle },
  { href: "/admin/jobs", label: "Admin Jobs", icon: ShieldCheck },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const activeHref =
    navItems
      .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;

  function isActive(href: string) {
    return activeHref === href;
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden w-56 shrink-0 border-r border-border bg-sidebar md:flex md:flex-col">
        <div className="relative flex h-14 items-center justify-between border-b border-border/60 px-4">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-4 bottom-0 h-px bg-gradient-to-r from-brand-pink-soft via-brand-lilac to-brand-purple"
          />
          <Link href="/dashboard">
            <SwatchWatchWordmark iconSize={26} />
          </Link>
          <ThemeToggle className="border-brand-purple/25 text-brand-purple-deep dark:text-brand-lilac" />
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => (
            <Button
              key={item.href}
              variant="ghost"
              data-active={isActive(item.href) ? "true" : "false"}
              className={cn(
                "nav-underline justify-start gap-2 rounded-xl border border-transparent px-3.5",
                isActive(item.href)
                  ? "font-medium border-brand-purple/25 bg-brand-pink-light/65 text-brand-purple-deep shadow-[0_12px_26px_rgba(66,16,126,0.14)] dark:bg-brand-purple/30 dark:text-brand-lilac"
                  : "hover:border-brand-purple/15 hover:bg-brand-pink-light/30 dark:hover:bg-brand-purple/20",
              )}
              asChild
            >
              <Link href={item.href}>
                <item.icon className="size-4" />
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>

        <div className="mt-auto border-t border-border/70 p-3">
          <UserCard />
        </div>
      </aside>

      {/* Mobile header + page content */}
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-background px-4 md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <Link href="/dashboard">
              <SwatchWatchWordmark iconSize={22} textClassName="text-sm" />
            </Link>
          </div>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto md:hidden">
            {navItems.map((item) => (
              <Button
                key={item.href}
                variant={isActive(item.href) ? "secondary" : "ghost"}
                size="sm"
                asChild
              >
                <Link href={item.href}>
                  <item.icon className="size-4" />
                </Link>
              </Button>
            ))}
          </nav>
          <ThemeToggle
            className="shrink-0 border-brand-purple/25 text-brand-purple-deep dark:text-brand-lilac md:hidden"
          />
        </header>

        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
