"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Info, Paintbrush, Shuffle, Trash2, WandSparkles } from "lucide-react";
import type { ManicurePolishRole, Polish } from "swatchwatch-shared";
import { toast } from "sonner";
import { BrandSpinner } from "@/components/brand-spinner";
import { ManiLogForm } from "@/components/mani-log-form";
import { Button } from "@/components/ui/button";
import { ToggleChip } from "@/components/toggle-chip";
import { deleteSavedLook, listAllPolishes, listPolishes, listSavedLooks, saveLookToServer } from "@/lib/api";
import { isOwnedPolish } from "@/lib/inventory-status";
import {
  LOOK_COUNT,
  LOOK_MOOD_LABELS,
  LOOK_OCCASION_LABELS,
  applyStepSwap,
  catalogQueriesForLooks,
  maniEntriesForLook,
  maniRoleForStep,
  recommendLooks,
  type Look,
  type LookStepRole,
  type Vibe,
} from "@/lib/looks";
import {
  SAVED_LOOKS_CACHE_KEY,
  SAVED_LOOKS_PENDING_KEY,
  addSavedLook,
  looksToUpload,
  mergeSavedLooks,
  readLookList,
  readSavedLooksForDisplay,
  removeSavedLook,
  toSavedLook,
  writeLookList,
  type SavedLook,
} from "@/lib/looks-saved";
import { buildLooksQueryString, parseLooksState, type LooksState } from "@/lib/looks-url";
import { toLocalIsoDate } from "@/lib/mani-log";
import { trackLooksGenerated, trackLooksWearClicked, type LooksTrigger } from "@/lib/metrics-events";
import { TOPPER_FINISHES } from "@/lib/pick-for-me";
import { LookCard, LookSwatchStrip } from "./look-card";
import { VibeSelector } from "./vibe-selector";

/** Catalog rows fetched per gap query (one color family, or toppers). */
const CATALOG_PAGE_SIZE = 60;
/** Most color-family queries per render, so a fully-empty collection doesn't fan out too far. */
const MAX_CATALOG_FAMILY_QUERIES = 6;
const TOPPER_QUERY_KEY = "toppers";

export default function LooksPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Mixing your looks…" />}>
      <LooksPageContent />
    </Suspense>
  );
}

/** Wear-this dialog state: the mani-log entries to start with. */
interface WearState {
  entries: { shadeId: string; role: ManicurePolishRole }[];
}

/**
 * Looks (`docs/looks-experience-plan.md`): pick a vibe, see three complete looks built from the
 * polishes you own, with the gaps you could buy. The vibe and Shuffle seed live in the URL
 * (`lib/looks-url.ts`); recommendations are computed client-side (`lib/looks.ts`), first from the
 * owned list, then again once catalog rows for the gaps arrive.
 */
function LooksPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const state = useMemo(() => parseLooksState(new URLSearchParams(queryString)), [queryString]);
  const stateKey = buildLooksQueryString(state);
  const { vibe, seed } = state;

  const [owned, setOwned] = useState<Polish[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, Polish[]>>({});
  const [overrides, setOverrides] = useState<{ key: string; looks: Record<string, Look> }>({ key: "", looks: {} });
  // Read once on the client (empty during SSR); only rendered once `result` exists, so hydration matches.
  const [saved, setSaved] = useState<SavedLook[]>(readSavedLooksForDisplay);
  const [tab, setTab] = useState<"looks" | "saved">("looks");
  const [wear, setWear] = useState<WearState | null>(null);
  const [todayIso] = useState(() => toLocalIsoDate(new Date()));
  // The trigger of the last explicit change, tied to the URL state it produced, so Back/Forward
  // (which change the URL without `setState`) are never reported as a shuffle.
  const triggerRef = useRef<{ stateKey: string; trigger: LooksTrigger } | null>(null);
  const trackedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAllPolishes({ status: ["owned"], sortBy: "createdAt", sortOrder: "desc" })
      .then((rows) => {
        if (!cancelled) setOwned(rows.filter(isOwnedPolish));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Fall back to template looks rather than a dead page.
        setLoadError(err instanceof Error ? err.message : "Couldn't load your collection");
        setOwned([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved looks: load the account's list, upload saves made offline or before the endpoint existed,
  // then cache the result. On failure the cached + pending lists stay on screen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const server = await listSavedLooks();
        const uploaded: SavedLook[] = [];
        for (const look of looksToUpload(readLookList(SAVED_LOOKS_PENDING_KEY), server)) {
          try {
            uploaded.push(await saveLookToServer(look));
          } catch {
            // Leave it pending for the next load.
          }
        }
        const merged = mergeSavedLooks([...uploaded, ...server], []);
        const stillPending = looksToUpload(readLookList(SAVED_LOOKS_PENDING_KEY), merged);
        writeLookList(SAVED_LOOKS_PENDING_KEY, stillPending);
        writeLookList(SAVED_LOOKS_CACHE_KEY, merged);
        if (!cancelled) setSaved(mergeSavedLooks(merged, stillPending));
      } catch {
        // Offline or an API without /api/looks: keep showing the local lists.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setState = useCallback(
    (next: LooksState, trigger: LooksTrigger) => {
      const qs = buildLooksQueryString(next);
      triggerRef.current = { stateKey: qs, trigger };
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router]
  );

  // Pass 1: owned polishes only. Its gaps decide which catalog rows to fetch.
  const ownedResult = useMemo(
    () => (owned ? recommendLooks({ polishes: owned, vibe, seed }) : null),
    [owned, vibe, seed]
  );

  const catalogKeys = useMemo(() => {
    if (!ownedResult || vibe.ownedOnly) return [];
    const queries = catalogQueriesForLooks(ownedResult.looks);
    const keys = queries.families.slice(0, MAX_CATALOG_FAMILY_QUERIES).map((family) => `family:${family}`);
    if (queries.toppers) keys.push(TOPPER_QUERY_KEY);
    return keys;
  }, [ownedResult, vibe.ownedOnly]);

  useEffect(() => {
    const missing = catalogKeys.filter((key) => !(key in catalog));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (key) => {
        try {
          const response =
            key === TOPPER_QUERY_KEY
              ? await listPolishes({ finishes: [...TOPPER_FINISHES], pageSize: CATALOG_PAGE_SIZE })
              : await listPolishes({
                  families: [key.slice("family:".length) as NonNullable<Polish["colorFamily"]>],
                  pageSize: CATALOG_PAGE_SIZE,
                });
          return [key, response.polishes] as const;
        } catch {
          // A failed gap query just leaves those steps as template swatches.
          return [key, [] as Polish[]] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setCatalog((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [catalogKeys, catalog]);

  const catalogReady = catalogKeys.every((key) => key in catalog);
  const catalogPool = useMemo(() => {
    const byId = new Map<string, Polish>();
    for (const key of catalogKeys) for (const row of catalog[key] ?? []) byId.set(row.id, row);
    return [...byId.values()];
  }, [catalogKeys, catalog]);

  // Pass 2: with catalog rows for the gaps.
  const result = useMemo(() => {
    if (!owned || !ownedResult) return null;
    if (catalogPool.length === 0) return ownedResult;
    return recommendLooks({ polishes: owned, catalog: catalogPool, vibe, seed });
  }, [owned, ownedResult, catalogPool, vibe, seed]);

  const resultKey = `${stateKey}|${catalogReady}|${owned?.length ?? -1}`;
  const looks = useMemo(() => {
    if (!result) return [];
    const swapped = overrides.key === resultKey ? overrides.looks : {};
    return result.looks.map((look) => swapped[look.templateId] ?? look);
  }, [result, overrides, resultKey]);

  useEffect(() => {
    if (!result || !catalogReady || trackedKeyRef.current === stateKey) return;
    trackedKeyRef.current = stateKey;
    const explicit = triggerRef.current?.stateKey === stateKey ? triggerRef.current : null;
    if (explicit) triggerRef.current = null;
    trackLooksGenerated({
      vibe,
      looks: result.looks,
      shortfall: result.shortfall,
      ownedCount: result.ownedCount,
      trigger: explicit?.trigger ?? "vibe",
    });
  }, [result, catalogReady, stateKey, vibe]);

  function changeVibe(next: Vibe) {
    setState({ vibe: next, seed }, "vibe");
  }

  function shuffle() {
    // A fresh seed per click; 1 is the default (omitted from the URL), so stay above it.
    const next = 2 + Math.floor(Math.random() * 1_000_000);
    setState({ vibe, seed: next === seed ? next + 1 : next }, "shuffle");
  }

  function swap(look: Look, role: LookStepRole, polish: Polish) {
    const next = applyStepSwap(look, role, polish);
    setOverrides((current) => ({
      key: resultKey,
      looks: { ...(current.key === resultKey ? current.looks : {}), [look.templateId]: next },
    }));
  }

  function wearLook(look: Look, position: number) {
    const original = result?.looks.find((l) => l.templateId === look.templateId);
    trackLooksWearClicked({ look, position, swapped: Boolean(original && original !== look) });
    setWear({ entries: maniEntriesForLook(look) });
  }

  async function toggleSave(look: Look) {
    const entry = toSavedLook(look, vibe, new Date());
    if (saved.some((s) => s.id === entry.id)) {
      await removeSaved(entry.id);
      return;
    }
    setSaved((current) => addSavedLook(current, entry));
    try {
      const stored = await saveLookToServer(entry);
      writeLookList(SAVED_LOOKS_CACHE_KEY, addSavedLook(readLookList(SAVED_LOOKS_CACHE_KEY), stored));
      toast.success(`Saved ${look.name}`);
    } catch {
      // Keep it on this device and upload it on the next visit.
      const ok = writeLookList(SAVED_LOOKS_PENDING_KEY, addSavedLook(readLookList(SAVED_LOOKS_PENDING_KEY), entry));
      if (ok) toast.success(`Saved ${look.name} on this device`, { description: "It will sync to your account next time." });
      else toast.error("Couldn't save this look", { description: "Storage may be full or blocked." });
    }
  }

  async function removeSaved(id: string) {
    const previous = saved;
    setSaved((current) => removeSavedLook(current, id));
    try {
      await deleteSavedLook(id);
    } catch {
      setSaved(previous);
      toast.error("Couldn't remove this look", { description: "Check your connection and try again." });
      return;
    }
    writeLookList(SAVED_LOOKS_CACHE_KEY, removeSavedLook(readLookList(SAVED_LOOKS_CACHE_KEY), id));
    writeLookList(SAVED_LOOKS_PENDING_KEY, removeSavedLook(readLookList(SAVED_LOOKS_PENDING_KEY), id));
  }

  function wearSaved(look: SavedLook) {
    const ownedIds = new Set((owned ?? []).map((p) => p.id));
    const entries = look.steps
      .filter((s) => s.source === "owned" && s.shadeId && ownedIds.has(s.shadeId))
      .map((s) => ({ shadeId: s.shadeId!, role: maniRoleForStep(s.role) }));
    if (entries.length === 0) {
      toast.error("You don't own any polish in this look anymore");
      return;
    }
    setWear({ entries });
  }

  const savedIds = useMemo(() => new Set(saved.map((s) => s.id)), [saved]);
  const ownedCount = result?.ownedCount ?? 0;
  const vibeSummary = `${LOOK_OCCASION_LABELS[vibe.occasion]} · ${LOOK_MOOD_LABELS[vibe.mood]}`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="heading-page flex items-center gap-2">
            <WandSparkles className="size-6 text-brand-purple" aria-hidden />
            Looks
          </h1>
          <p className="text-muted-foreground">Pick a vibe. Get three complete looks from the polishes you own.</p>
        </div>
        {tab === "looks" && (
          <Button type="button" variant="outline" onClick={shuffle} disabled={!result}>
            <Shuffle className="size-4" aria-hidden />
            Shuffle
          </Button>
        )}
      </div>

      <div className="flex gap-1.5" role="group" aria-label="Show">
        <ToggleChip pressed={tab === "looks"} onPressedChange={() => setTab("looks")} className="rounded-full border border-border">
          For your vibe
        </ToggleChip>
        <ToggleChip pressed={tab === "saved"} onPressedChange={() => setTab("saved")} className="rounded-full border border-border">
          {/* The count comes from localStorage, so it waits for the client-only `result` to keep hydration stable. */}
          Saved{result && saved.length > 0 ? ` (${saved.length})` : ""}
        </ToggleChip>
      </div>

      {tab === "looks" ? (
        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
            <VibeSelector vibe={vibe} onChange={changeVibe} />
          </aside>

          <section aria-label={`Looks for ${vibeSummary}`} aria-busy={!result} className="@container min-w-0 space-y-4">
            {loadError && (
              <Notice>
                Couldn&apos;t load your collection ({loadError}), so these looks use template colors.
              </Notice>
            )}
            {result && ownedCount === 0 && !loadError && (
              <Notice>
                {vibe.ownedOnly
                  ? "You haven't added polishes you own yet."
                  : "You haven't added polishes you own yet, so these looks use catalog shades."}{" "}
                <Link href="/polishes/import" className="font-medium underline">
                  Import your collection
                </Link>{" "}
                or{" "}
                <Link href="/rapid-add" className="font-medium underline">
                  Rapid Add
                </Link>{" "}
                a few bottles to see looks you can wear today.{" "}
                {vibe.ownedOnly && (
                  <button type="button" className="font-medium underline" onClick={() => changeVibe({ ...vibe, ownedOnly: false })}>
                    Show catalog looks
                  </button>
                )}
              </Notice>
            )}
            {result && result.shortfall && ownedCount > 0 && (
              <Notice>
                {result.looks.length === 0
                  ? "None of our looks can be made only from polishes you own yet."
                  : `Only ${result.looks.length} of ${LOOK_COUNT} looks can be made from polishes you own for this vibe.`}{" "}
                {vibe.ownedOnly && (
                  <button type="button" className="font-medium underline" onClick={() => changeVibe({ ...vibe, ownedOnly: false })}>
                    Show looks with polishes to add
                  </button>
                )}
              </Notice>
            )}

            {!result ? (
              <BrandSpinner label="Mixing your looks…" />
            ) : (
              <div className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3" aria-live="polite">
                {looks.map((look, index) => (
                  <LookCard
                    key={look.templateId}
                    look={look}
                    saved={savedIds.has(toSavedLook(look, vibe, new Date(0)).id)}
                    onWear={() => wearLook(look, index)}
                    onSave={() => void toggleSave(look)}
                    onSwap={(role, polish) => swap(look, role, polish)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

      ) : !result ? (
        <BrandSpinner label="Loading your saved looks…" />
      ) : saved.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No saved looks yet. Tap <span className="font-medium text-foreground">Save</span> on a look to keep it here,
          on every device you sign in on.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Saved looks">
          {saved.map((look) => (
            <li key={look.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">{look.name}</p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {LOOK_OCCASION_LABELS[look.vibe.occasion]} · {LOOK_MOOD_LABELS[look.vibe.mood]}
                </span>
              </div>
              <LookSwatchStrip steps={look.steps} className="h-8" />
              <p className="truncate text-xs text-muted-foreground">
                {look.steps.map((s) => s.name ?? s.label).join(" · ")}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => wearSaved(look)}>
                  <Paintbrush className="size-4" aria-hidden />
                  Wear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${look.name} from saved looks`}
                  onClick={() => void removeSaved(look.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ManiLogForm
        open={wear !== null}
        onOpenChange={(open) => {
          if (!open) setWear(null);
        }}
        todayIso={todayIso}
        collection={owned ?? []}
        collectionLoading={owned === null}
        initialEntries={wear?.entries}
        onSaved={() => setWear(null)}
      />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-brand-purple/20 bg-brand-purple/5 px-3 py-2 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-brand-purple" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
