"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/polishes", label: "Collection", icon: "💅" },
  { href: "/polishes/search", label: "Color Search", icon: "🎨" },
  { href: "/polishes/new", label: "Add Polish", icon: "➕" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden w-56 shrink-0 border-r border-border bg-sidebar md:block">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="text-lg">💅</span>
            <span>Polish Inventory</span>
          </Link>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => (
            <Button
              key={item.href}
              variant={pathname === item.href ? "secondary" : "ghost"}
              className={cn(
                "justify-start gap-2",
                pathname === item.href && "font-medium"
              )}
              asChild
            >
              <Link href={item.href}>
                <span>{item.icon}</span>
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>
      </aside>

      {/* Mobile header */}
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-background px-4 md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <span className="text-lg">💅</span>
            <span className="font-semibold">Polish Inventory</span>
          </div>
          <nav className="flex items-center gap-1 md:hidden">
            {navItems.map((item) => (
              <Button
                key={item.href}
                variant={pathname === item.href ? "secondary" : "ghost"}
                size="sm"
                asChild
              >
                <Link href={item.href}>
                  <span className="text-sm">{item.icon}</span>
                </Link>
              </Button>
            ))}
          </nav>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
