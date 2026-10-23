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
  recommendLooks,
  resolveProductCategory,
  type Look,
  type LookStep,
  type Polish,
  type PolishStatus,
  type SavedLook,
  type Vibe,
} from "swatchwatch-shared";
import { deleteSavedLook, errorMessage, listAllPolishes, listPolishes, listSavedLooks, saveLook, updatePolish } from "@/api/client";
import { LogManiSheet } from "@/components/log-mani-sheet";
import { Swatch } from "@/components/swatch";
import { EmptyState, startCollectionActions } from "@/components/empty-state";
import { AppText, Button, Card, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { confirmAddWithDupes } from "@/lib/add-guard";
import {
  addSavedLook,
  catalogGapQueries,
  maniEntriesFromLook,
  maniEntriesFromSavedLook,
  nextSeed,
  toSavedLook,
} from "@/lib/looks";
import type { ManiEntry } from "@/lib/mani";
import { statusChangePatch } from "@/lib/status";
import { useTheme } from "@/theme/theme";

/**
 * Looks (web: `/polishes/looks`): pick a vibe, get three complete looks built from the polishes
 * you own (the shared, seeded `recommendLooks`, no endpoint), with catalog gaps to Add or
 * wishlist. Shuffle changes the seed; Save keeps a look in the account (`/api/looks`); "Wear
 * this" opens the mani sheet with the owned steps and their roles.
 */
export default function LooksScreen() {
  const theme = useTheme();
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

  const looks = result?.looks ?? [];
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
            <VibePicker vibe={vibe} toppers={toppers} onVibe={setVibe} onToppers={setToppers} />
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
      <View style={row}>
        <Chip label="Owned only" selected={vibe.ownedOnly} onPress={() => onVibe({ ...vibe, ownedOnly: !vibe.ownedOnly })} />
        <Chip label="Include toppers" selected={toppers} onPress={() => onToppers(!toppers)} />
      </View>
    </View>
  );
}

/** What a card shows per step: a fresh look has the polish row, a saved one only its snapshot text. */
type StepView = Pick<LookStep, "role" | "label" | "hex" | "source"> & { polish?: Polish | null; brand?: string; name?: string };

/** A look: swatch strip, steps (Owned ✓ / Add / ♡) and actions. Saved looks pass steps without polishes. */
function LookCard({
  name,
  description,
  meta,
  steps,
  moved,
  busy,
  onStatus,
  actions,
}: {
  name: string;
  description: string;
  meta?: string;
  steps: StepView[];
  moved: Record<string, PolishStatus>;
  busy: ReadonlySet<string>;
  onStatus?: (polish: Polish, status: PolishStatus) => void;
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
      <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>{actions}</View>
    </Card>
  );
}
