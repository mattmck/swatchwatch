import Link from "next/link";
import { SwatchWatchWordmark } from "@/components/brand/swatchwatch-brand";
import { Button } from "@/components/ui/button";
import { MarketingThemeToggle } from "@/components/marketing-theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Menu } from "lucide-react";

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:h-16 sm:px-6">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-gradient-to-r from-brand-pink-soft/0 via-brand-lilac to-brand-purple/0"
          />
          <Link href="/" className="shrink-0">
            <SwatchWatchWordmark
              iconSize={24}
              className="gap-2"
              textClassName="text-sm sm:text-base"
            />
          </Link>

          <div className="hidden items-center gap-2 sm:flex">
            <MarketingThemeToggle />
            <Button
              asChild
              variant="outline"
              size="sm"
              className="border-brand-purple/25 text-brand-purple-deep hover:bg-brand-pink-light/25 dark:text-brand-lilac"
            >
              <Link href="/polishes">View Collection</Link>
            </Button>
            <Button asChild variant="brand">
              <Link href="/dashboard">Open App</Link>
            </Button>
          </div>

          <div className="flex items-center gap-2 sm:hidden">
            <MarketingThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="border-brand-purple/25 text-brand-purple-deep dark:text-brand-lilac"
                  aria-label="Open navigation menu"
                >
                  <Menu className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Navigate</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/polishes">View Collection</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/dashboard">Open App</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border/70 bg-muted/35 py-8 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <SwatchWatchWordmark iconSize={20} className="justify-center" />
          <p>Your smart nail polish collection manager</p>
        </div>
      </footer>
    </div>
  );
}
