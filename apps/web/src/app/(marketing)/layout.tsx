import Link from "next/link";
import { SwatchWatchWordmark } from "@/components/brand/swatchwatch-brand";
import { Button } from "@/components/ui/button";

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 glass border-b border-border/50">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 h-16">
          <SwatchWatchWordmark iconSize={28} />
          <Button asChild className="bg-gradient-brand text-white hover:opacity-90">
            <Link href="/dashboard">Open App</Link>
          </Button>
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
