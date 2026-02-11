"use client";

import { useEffect, useMemo, useState } from "react";
import { Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "swatchwatch-theme";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function MarketingThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") {
      setPreference(saved);
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => {
      setSystemTheme(media.matches ? "dark" : "light");
    };

    syncSystemTheme();
    media.addEventListener("change", syncSystemTheme);
    setMounted(true);

    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  const resolvedTheme: ResolvedTheme = useMemo(
    () => (preference === "system" ? systemTheme : preference),
    [preference, systemTheme],
  );

  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    localStorage.setItem(STORAGE_KEY, preference);
  }, [mounted, preference, resolvedTheme]);

  const TriggerIcon = resolvedTheme === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Theme: ${preference}`}
          title={`Theme: ${preference}`}
        >
          {mounted ? <TriggerIcon className="size-4" /> : <Sun className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setPreference("system")}>
          <Laptop className="size-4" />
          System
          {preference === "system" && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPreference("light")}>
          <Sun className="size-4" />
          Light
          {preference === "light" && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPreference("dark")}>
          <Moon className="size-4" />
          Dark
          {preference === "dark" && <span className="ml-auto text-xs">✓</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
