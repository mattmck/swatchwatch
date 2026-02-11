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
      <header className="sticky top-0 z-50 glass border-b border-border/50">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:h-16 sm:px-6">
          <Link href="/" className="shrink-0">
            <SwatchWatchWordmark
              iconSize={24}
              className="gap-2"
              textClassName="text-sm sm:text-base"
            />
          </Link>

          <div className="hidden items-center gap-2 sm:flex">
            <MarketingThemeToggle />
            <Button asChild variant="outline" size="sm">
              <Link href="/polishes">View Collection</Link>
            </Button>
            <Button asChild className="bg-gradient-brand text-white hover:opacity-90">
              <Link href="/dashboard">Open App</Link>
            </Button>
          </div>

          <div className="flex items-center gap-2 sm:hidden">
            <MarketingThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Open navigation menu">
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

      <footer className="border-t border-border bg-muted/50 py-8 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <SwatchWatchWordmark iconSize={20} className="justify-center" />
          <p>Your smart nail polish collection manager</p>
        </div>
      </footer>
    </div>
  );
}
