"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Sparkles, Search, PlusCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SwatchWatchWordmark } from "@/components/brand/swatchwatch-brand";
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
      <aside className="hidden w-56 shrink-0 border-r border-border bg-sidebar md:block">
        <div className="flex h-14 items-center border-b border-border/60 px-4">
          <Link href="/dashboard">
            <SwatchWatchWordmark iconSize={26} />
          </Link>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => (
            <Button
              key={item.href}
              variant={isActive(item.href) ? "secondary" : "ghost"}
              className={cn(
                "justify-start gap-2",
                isActive(item.href) && "font-medium"
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
      </aside>

      {/* Mobile header + page content */}
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-background px-4 md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <Link href="/dashboard">
              <SwatchWatchWordmark iconSize={22} textClassName="text-sm" />
            </Link>
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto md:hidden">
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
        </header>

        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
