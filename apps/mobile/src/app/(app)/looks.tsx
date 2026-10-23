import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import {
  DEFAULT_VIBE,
  LOOK_FINISHES,
  LOOK_FINISH_LABELS,
  LOOK_MOODS,
  LOOK_MOOD_LABELS,
  LOOK_OCCASIONS,
  LOOK_OCCASION_LABELS,
  MAX_SAVED_LOOKS,
  SKIN_DEPTHS,
  SKIN_UNDERTONES,
  lookShareText,
  recommendLooks,
  shoppingListText,
  skinToneFrom,
  resolveProductCategory,
  type Look,
  type LookStep,
  type Polish,
  type PolishStatus,
  type SavedLook,
  type Vibe,
} from "swatchwatch-shared";
import { deleteSavedLook, errorMessage, listAllPolishes, listPolishes, listSavedLooks, saveLook, updatePolish } from "@/api/client";
import { useAuth } from "@/auth/auth-provider";
import { LogManiSheet } from "@/components/log-mani-sheet";
import { LookDetailsSheet, ShoppingListSheet, SwapSheet } from "@/components/look-sheets";
import { Swatch } from "@/components/swatch";
import { EmptyState, startCollectionActions } from "@/components/empty-state";
import { AppText, Button, Card, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { confirmAddWithDupes } from "@/lib/add-guard";
import { readCache, writeCache } from "@/lib/api-cache";
import {
  addSavedLook,
  applySwaps,
  catalogGapQueries,
  maniEntriesFromLook,
  maniEntriesFromSavedLook,
  nextSeed,
  NO_SWAPS,
  parseCachedSkinTone,
  SKIN_TONE_CACHE_KEY,
  toSavedLook,
  withSwap,
  type SwapOverrides,
} from "@/lib/looks";
import type { ManiEntry } from "@/lib/mani";
import { statusChangePatch } from "@/lib/status";
import { useTheme } from "@/theme/theme";

/**
 * Looks (web: `/polishes/looks`): pick a vibe, get three complete looks built from the polishes
 * you own (the shared, seeded `recommendLooks`, no endpoint), with catalog gaps to Add or
 * wishlist. Shuffle changes the seed; Save keeps a look in the account (`/api/looks`); "Wear
 * this" opens the mani sheet with the owned steps and their roles. Per step, Swap trades in
 * another owned polish; Details (application order, finish notes, substitutions) and "Add
 * missing items" (buy links with brand list prices, ♡ through the add guard, per-currency
 * subtotals, copy list) open sheets; Copy look puts the web's share text on the clipboard.
 */

type LookSheet = { kind: "swap" | "details" | "shop"; templateId: string; stepIndex?: number };

export default function LooksScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const [vibe, setVibe] = useState<Vibe>(DEFAULT_VIBE);
  const [toppers, setToppers] = useState(true);
  const [seed, setSeed] = useState(() => nextSeed(0));
  const [owned, setOwned] = useState<Polish[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, Polish[]>>({});
  const [tab, setTab] = useState<"looks" | "saved">("looks");
  const [saved, setSaved] = useState<SavedLook[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Status a catalog polish was moved to from this screen (Add / ♡), by shade id. */
  const [moved, setMoved] = useState<Record<string, PolishStatus>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [wear, setWear] = useState<ManiEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<SwapOverrides>(NO_SWAPS);
  const [sheet, setSheet] = useState<LookSheet | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAllPolishes({ status: ["owned"], sortBy: "createdAt", sortOrder: "desc" })
      .then((rows) => !cancelled && setOwned(rows.filter((p) => p.status === "owned")))
      .catch((err: unknown) => {
        if (cancelled) return;
        // Template looks beat a dead screen.
        setLoadError(errorMessage(err, "Couldn't load your collection."));
        setOwned([]);
      });
    listSavedLooks()
      .then((list) => !cancelled && setSaved(list))
      .catch((err: unknown) => !cancelled && setSavedError(errorMessage(err, "Couldn't load your saved looks.")));
    return () => {
      cancelled = true;
    };
  }, []);

  // The remembered skin tone (per user, `api-cache`): restored once, rewritten so it doesn't lapse.
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void readCache<unknown>(scope, SKIN_TONE_CACHE_KEY).then((entry) => {
      const skinTone = entry ? parseCachedSkinTone(entry.data) : null;
      if (cancelled || !skinTone) return;
      setVibe((current) => (current.skinTone ? current : { ...current, skinTone }));
      void writeCache(scope, SKIN_TONE_CACHE_KEY, skinTone);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const changeVibe = useCallback(
    (next: Vibe) => {
      setVibe(next);
      // A cleared choice is stored as an empty object, which reads back as "none".
      if (scope && next.skinTone !== vibe.skinTone) void writeCache(scope, SKIN_TONE_CACHE_KEY, next.skinTone ?? {});
    },
    [scope, vibe.skinTone],
  );

  // Pass 1: owned polishes only. Its gaps decide which catalog rows to fetch.
  const ownedResult = useMemo(
    () => (owned ? recommendLooks({ polishes: owned, vibe, seed, includeToppers: toppers }) : null),
    [owned, vibe, seed, toppers],
  );
  const gapQueries = useMemo(
    () => (ownedResult && !vibe.ownedOnly ? catalogGapQueries(ownedResult.looks) : []),
    [ownedResult, vibe.ownedOnly],
  );

  useEffect(() => {
    const missing = gapQueries.filter((q) => !(q.key in catalog));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((q) =>
        listPolishes(q.filters).then(
          (res) => [q.key, res.polishes] as const,
          () => [q.key, [] as Polish[]] as const, // a failed gap query just yields no rows
        ),
      ),
    ).then((entries) => {
      if (!cancelled) setCatalog((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [gapQueries, catalog]);

  const catalogReady = gapQueries.every((q) => q.key in catalog);
  const catalogPool = useMemo(() => {
    const byId = new Map<string, Polish>();
    for (const q of gapQueries) for (const row of catalog[q.key] ?? []) byId.set(row.id, row);
    return [...byId.values()];
  }, [gapQueries, catalog]);

  // Pass 2: with catalog rows for the gaps.
  const result = useMemo(() => {
    if (!owned || !ownedResult) return null;
    if (catalogPool.length === 0) return ownedResult;
    return recommendLooks({ polishes: owned, catalog: catalogPool, vibe, seed, includeToppers: toppers });
  }, [owned, ownedResult, catalogPool, vibe, seed, toppers]);

  // Swaps belong to one recommendation: Shuffle, a vibe change or new catalog rows start over.
  const resultKey = `${JSON.stringify(vibe)}|${seed}|${toppers}|${catalogReady}|${owned?.length ?? -1}`;
  const looks = useMemo(() => (result ? applySwaps(result.looks, overrides, resultKey) : []), [result, overrides, resultKey]);

  // Swap / Details sheets: catalog rows near the open look's colors (owned steps too) for "to buy"
  // substitutes. They feed only the sheets (`sheetPool`), never `recommendLooks`, so opening one
  // can't reshuffle the looks.
  const sheetTemplateId = sheet && sheet.kind !== "shop" ? sheet.templateId : null;
  const sheetQueries = useMemo(() => {
    const open = sheetTemplateId ? looks.find((l) => l.templateId === sheetTemplateId) : null;
    return open && !vibe.ownedOnly ? catalogGapQueries([open], { includeOwned: true }) : [];
  }, [sheetTemplateId, looks, vibe.ownedOnly]);
  useEffect(() => {
    const missing = sheetQueries.filter((q) => !(q.key in catalog));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((q) =>
        listPolishes(q.filters).then(
          (res) => [q.key, res.polishes] as const,
          () => [q.key, [] as Polish[]] as const,
        ),
      ),
    ).then((entries) => {
      if (!cancelled) setCatalog((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [sheetQueries, catalog]);
  const sheetLoading = sheetQueries.some((q) => !(q.key in catalog));
  const sheetPool = useMemo(() => {
    if (vibe.ownedOnly) return [];
    const byId = new Map<string, Polish>();
    for (const rows of Object.values(catalog)) for (const row of rows) byId.set(row.id, row);
    return [...byId.values()];
  }, [catalog, vibe.ownedOnly]);
  const sheetLook = sheet ? (looks.find((l) => l.templateId === sheet.templateId) ?? null) : null;

  const savedIds = useMemo(() => new Set(saved.map((s) => s.id)), [saved]);

  const setStatus = useCallback(async (polish: Polish, status: PolishStatus) => {
    const choice = await confirmAddWithDupes(polish.id, status === "owned" ? "owned" : "wishlist");
    if (choice === "cancel") return;
    const target: PolishStatus = choice === "wishlist" ? "wishlist" : status;
    setBusy((b) => new Set(b).add(polish.id));
    setActionError(null);
    try {
      const updated = await updatePolish(polish.id, statusChangePatch(polish, target));
      setMoved((m) => ({ ...m, [polish.id]: updated.status ?? target }));
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't update that polish."));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(polish.id);
        return next;
      });
    }
  }, []);

  async function save(look: Look) {
    const entry = toSavedLook(look, vibe, new Date());
    setActionError(null);
    try {
      const stored = await saveLook(entry);
      setSaved((list) => addSavedLook(list, stored));
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't save that look."));
    }
  }

  function swap(look: Look, stepIndex: number, polish: Polish) {
    setOverrides((current) => withSwap(current, resultKey, look, stepIndex, polish));
  }

  /** Copy text to the clipboard and say so (or that it failed). */
  async function copy(text: string, done: string) {
    setActionError(null);
    try {
      await Clipboard.setStringAsync(text);
      setNotice(done);
    } catch {
      setNotice(null);
      setActionError("Couldn't copy to the clipboard.");
    }
  }

  async function remove(id: string) {
    setActionError(null);
    try {
      await deleteSavedLook(id);
      setSaved((list) => list.filter((l) => l.id !== id));
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't delete that look."));
    }
  }

  /** Owned steps, plus catalog steps the user just added to the collection from this screen. */
  function wearEntries(look: Look): ManiEntry[] {
    const base = maniEntriesFromLook(look);
    const added = maniEntriesFromLook({
      steps: look.steps.map((s) => (s.source === "catalog" && s.polish && moved[s.polish.id] === "owned" ? { ...s, source: "owned" as const } : s)),
    });
    return added.length > base.length ? added : base;
  }

  if (!owned) return <CenteredState loading title="Mixing your looks…" />;

  return (
    <>
      <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
          <Chip label="Looks" selected={tab === "looks"} onPress={() => setTab("looks")} />
          <Chip label={`Saved (${saved.length}/${MAX_SAVED_LOOKS})`} selected={tab === "saved"} onPress={() => setTab("saved")} />
        </View>
        {loadError && <ErrorBanner message={`${loadError} Showing template looks.`} />}
        {actionError && <ErrorBanner message={actionError} />}
        {notice && (
          <AppText variant="small" style={{ color: theme.colors.success }}>
            {notice}
          </AppText>
        )}

        {tab === "looks" && owned.filter((p) => p.status === "owned" && resolveProductCategory(p) === "color").length === 0 ? (
          <EmptyState
            testID="looks-empty"
            title="Looks need polishes to work with"
            message="Add a few color polishes you own and SwatchWatch builds complete looks from them."
            actions={startCollectionActions()}
          />
        ) : tab === "looks" ? (
          <>
            <VibePicker vibe={vibe} toppers={toppers} onVibe={changeVibe} onToppers={setToppers} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <Button title="Shuffle" variant="outline" compact onPress={() => setSeed((s) => nextSeed(s))} testID="looks-shuffle" />
              <AppText variant="tiny" muted style={{ flex: 1 }}>
                {result ? `From ${result.ownedCount} owned polishes` : ""}
                {!catalogReady && !vibe.ownedOnly ? " · finding catalog shades…" : ""}
              </AppText>
            </View>
            {result?.shortfall && (
              <AppText variant="small" muted>
                Only {looks.length} look{looks.length === 1 ? "" : "s"} fit{looks.length === 1 ? "s" : ""} this vibe from what you own
                {vibe.ownedOnly ? ". Turn off Owned only to fill the gaps from the catalog." : "."}
              </AppText>
            )}
            {looks.length === 0 && (
              <CenteredState title="No looks yet" message="Try another vibe, or turn off Owned only." />
            )}
            {looks.map((look) => {
              const entry = toSavedLook(look, vibe, new Date(0));
              return (
                <LookCard
                  key={look.templateId}
                  name={look.name}
                  description={look.description}
                  meta={`${look.difficulty} · ${look.minutes} min · ${look.ownedSteps} owned${look.missingSteps ? `, ${look.missingSteps} to add` : ""}`}
                  steps={look.steps}
                  moved={moved}
                  busy={busy}
                  onStatus={(polish, status) => void setStatus(polish, status)}
                  onSwap={(stepIndex) => setSheet({ kind: "swap", templateId: look.templateId, stepIndex })}
                  extras={
                    <>
                      {look.missingSteps > 0 && (
                        <Button
                          title={`Add missing items (${look.missingSteps})`}
                          variant="outline"
                          compact
                          onPress={() => setSheet({ kind: "shop", templateId: look.templateId })}
                          testID="looks-shop"
                        />
                      )}
                      <Button title="Details" variant="ghost" compact onPress={() => setSheet({ kind: "details", templateId: look.templateId })} testID="looks-details" />
                      <Button
                        title="Copy look"
                        variant="ghost"
                        compact
                        // No web origin on mobile, so unlike the web there is no vibe/seed link at the end.
                        onPress={() => void copy(lookShareText(look, vibe), "Look copied. Paste it into a message to share it.")}
                        testID="looks-copy"
                      />
                    </>
                  }
                  actions={
                    <>
                      <Button
                        title={savedIds.has(entry.id) ? "Saved ✓" : "Save"}
                        variant="outline"
                        compact
                        disabled={savedIds.has(entry.id)}
                        onPress={() => void save(look)}
                        style={{ flex: 1 }}
                      />
                      <Button
                        title="Wear this"
                        variant="brand"
                        compact
                        disabled={wearEntries(look).length === 0}
                        onPress={() => setWear(wearEntries(look))}
                        style={{ flex: 1 }}
                      />
                    </>
                  }
                />
              );
            })}
          </>
        ) : (
          <>
            {savedError && <ErrorBanner message={savedError} />}
            {saved.length === 0 && !savedError && (
              <CenteredState title="No saved looks" message="Save a look you like and it will be here, on the web too." />
            )}
            {saved.map((look) => (
              <LookCard
                key={look.id}
                name={look.name}
                description={`${LOOK_OCCASION_LABELS[look.vibe.occasion]} · ${LOOK_MOOD_LABELS[look.vibe.mood]}${look.vibe.finish ? ` · ${LOOK_FINISH_LABELS[look.vibe.finish]}` : ""}`}
                steps={look.steps}
                moved={moved}
                busy={busy}
                actions={
                  <>
                    <Button title="Delete" variant="outline" compact onPress={() => void remove(look.id)} style={{ flex: 1 }} />
                    <Button
                      title="Wear this"
                      variant="brand"
                      compact
                      disabled={maniEntriesFromSavedLook(look).length === 0}
                      onPress={() => setWear(maniEntriesFromSavedLook(look))}
                      style={{ flex: 1 }}
                    />
                  </>
                }
              />
            ))}
          </>
        )}
      </ScrollView>
      <SwapSheet
        look={sheet?.kind === "swap" ? sheetLook : null}
        stepIndex={sheet?.stepIndex ?? null}
        pool={sheetPool}
        vibe={vibe}
        loading={sheetLoading}
        onSwap={(stepIndex, polish) => sheetLook && swap(sheetLook, stepIndex, polish)}
        onClose={() => setSheet(null)}
      />
      <LookDetailsSheet
        look={sheet?.kind === "details" ? sheetLook : null}
        pool={sheetPool}
        vibe={vibe}
        loading={sheetLoading}
        onSwap={(stepIndex, polish) => sheetLook && swap(sheetLook, stepIndex, polish)}
        onClose={() => setSheet(null)}
      />
      <ShoppingListSheet
        look={sheet?.kind === "shop" ? sheetLook : null}
        moved={moved}
        busy={busy}
        onWishlist={(polish) => void setStatus(polish, "wishlist")}
        onCopy={(look) => void copy(shoppingListText(look), "Shopping list copied.")}
        onClose={() => setSheet(null)}
      />
      <LogManiSheet
        visible={wear !== null}
        initialEntries={wear ?? undefined}
        onClose={() => setWear(null)}
        onLogged={(_mani, photoError) => {
          setWear(null);
          setNotice(photoError ? `Logged the mani. ${photoError}` : "Logged the mani.");
        }}
      />
    </>
  );
}

const UNDERTONE_LABELS = { cool: "Cool", neutral: "Neutral", warm: "Warm" } as const;
const DEPTH_LABELS = { fair: "Fair", light: "Light", medium: "Medium", tan: "Tan", deep: "Deep" } as const;

function VibePicker({
  vibe,
  toppers,
  onVibe,
  onToppers,
}: {
  vibe: Vibe;
  toppers: boolean;
  onVibe: (vibe: Vibe) => void;
  onToppers: (on: boolean) => void;
}) {
  const theme = useTheme();
  const row = { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) } as const;
  return (
    <View style={{ gap: theme.spacing(3) }}>
      <View style={{ gap: theme.spacing(1.5) }}>
        <AppText variant="label" muted>
          Occasion
        </AppText>
        <View style={row}>
          {LOOK_OCCASIONS.map((o) => (
            <Chip key={o} label={LOOK_OCCASION_LABELS[o]} selected={vibe.occasion === o} onPress={() => onVibe({ ...vibe, occasion: o })} />
          ))}
        </View>
      </View>
      <View style={{ gap: theme.spacing(1.5) }}>
        <AppText variant="label" muted>
          Mood
        </AppText>
        <View style={row}>
          {LOOK_MOODS.map((m) => (
            <Chip key={m} label={LOOK_MOOD_LABELS[m]} selected={vibe.mood === m} onPress={() => onVibe({ ...vibe, mood: m })} />
          ))}
        </View>
      </View>
      <View style={{ gap: theme.spacing(1.5) }}>
        <AppText variant="label" muted>
          Finish
        </AppText>
        <View style={row}>
          <Chip label="Any" selected={vibe.finish === null} onPress={() => onVibe({ ...vibe, finish: null })} />
          {LOOK_FINISHES.map((f) => (
            <Chip key={f} label={LOOK_FINISH_LABELS[f]} selected={vibe.finish === f} onPress={() => onVibe({ ...vibe, finish: vibe.finish === f ? null : f })} />
          ))}
        </View>
      </View>
      <View style={{ gap: theme.spacing(1.5) }}>
        <AppText variant="label" muted>
          Skin tone (optional)
        </AppText>
        <View style={row}>
          <Chip label="Any" selected={!vibe.skinTone} onPress={() => onVibe({ ...vibe, skinTone: null })} />
          {SKIN_UNDERTONES.map((u) => (
            <Chip
              key={u}
              label={UNDERTONE_LABELS[u]}
              selected={vibe.skinTone?.undertone === u}
              onPress={() => onVibe({ ...vibe, skinTone: skinToneFrom(u, vibe.skinTone?.depth ?? null) })}
            />
          ))}
        </View>
        {vibe.skinTone && (
          <View style={row}>
            {SKIN_DEPTHS.map((d) => (
              <Chip
                key={d}
                label={DEPTH_LABELS[d]}
                selected={vibe.skinTone?.depth === d}
                onPress={() => onVibe({ ...vibe, skinTone: skinToneFrom(vibe.skinTone?.undertone ?? null, d) })}
              />
            ))}
          </View>
        )}
      </View>
      <View style={row}>
        <Chip label="Owned only" selected={vibe.ownedOnly} onPress={() => onVibe({ ...vibe, ownedOnly: !vibe.ownedOnly })} />
        <Chip label="Include toppers" selected={toppers} onPress={() => onToppers(!toppers)} />
      </View>
    </View>
  );
}

/** What a card shows per step: a fresh look has the polish row, a saved one only its snapshot text. */
type StepView = Pick<LookStep, "role" | "label" | "hex" | "source"> & {
  polish?: Polish | null;
  brand?: string;
  name?: string;
  /** Owned polishes that can replace this step (fresh looks only); Swap shows when there are any. */
  alternatives?: readonly Polish[];
};

/** A look: swatch strip, steps (Owned ✓ / Add / ♡) and actions. Saved looks pass steps without polishes. */
function LookCard({
  name,
  description,
  meta,
  steps,
  moved,
  busy,
  onStatus,
  onSwap,
  extras,
  actions,
}: {
  name: string;
  description: string;
  meta?: string;
  steps: StepView[];
  moved: Record<string, PolishStatus>;
  busy: ReadonlySet<string>;
  onStatus?: (polish: Polish, status: PolishStatus) => void;
  /** Open the Swap sheet for a step (fresh looks only). */
  onSwap?: (stepIndex: number) => void;
  /** Detail buttons between the steps and the main actions. */
  extras?: ReactNode;
  actions: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Card testID="look-card">
      <View style={{ gap: 2 }}>
        <AppText variant="heading">{name}</AppText>
        <AppText variant="small" muted>
          {description}
        </AppText>
        {meta && (
          <AppText variant="tiny" muted>
            {meta}
          </AppText>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: theme.spacing(1.5) }} accessibilityLabel={`${name} colors`}>
        {steps.map((step, i) => (
          <Swatch key={`${step.role}:${i}`} hex={step.hex} imageUrl={step.polish?.swatchImageUrl} size={44} />
        ))}
      </View>
      <View style={{ gap: theme.spacing(2.5) }}>
        {steps.map((step, i) => {
          const polish = step.polish;
          const status = polish ? (moved[polish.id] ?? polish.status) : undefined;
          const brand = polish?.brand ?? step.brand;
          const shade = polish?.name ?? step.name;
          return (
            <View key={`${step.role}:${i}`} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <Swatch hex={step.hex} size={28} rounded="full" />
              <View style={{ flex: 1 }}>
                <AppText variant="tiny" muted numberOfLines={1}>
                  {step.label}
                </AppText>
                <AppText variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
                  {shade ? `${brand ? `${brand} — ` : ""}${shade}` : "No match — look for this color"}
                </AppText>
              </View>
              {onSwap && step.alternatives && step.alternatives.length > 0 && (
                <Button title="Swap" variant="ghost" compact accessibilityLabel={`Swap ${step.label}`} onPress={() => onSwap(i)} />
              )}
              {onStatus && polish && step.source !== "owned" ? (
                status === "owned" ? (
                  <Chip label="Owned ✓" tone="success" />
                ) : status === "wishlist" ? (
                  <Chip label="♡ Wishlist" tone="brand" />
                ) : (
                  <View style={{ flexDirection: "row", gap: theme.spacing(1) }}>
                    <Button title="Add" variant="outline" compact disabled={busy.has(polish.id)} onPress={() => onStatus(polish, "owned")} />
                    <Button
                      title="♡"
                      variant="outline"
                      compact
                      accessibilityLabel={`Add ${shade} to wishlist`}
                      disabled={busy.has(polish.id)}
                      onPress={() => onStatus(polish, "wishlist")}
                    />
                  </View>
                )
              ) : step.source === "owned" ? (
                <Chip label="Owned ✓" tone="success" />
              ) : step.source === "catalog" ? (
                <Chip label="Add" tone="warning" />
              ) : (
                <Chip label="To find" tone="warning" />
              )}
            </View>
          );
        })}
      </View>
      {extras ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>{extras}</View> : null}
      <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>{actions}</View>
    </Card>
  );
}
