import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, ScrollView, View } from "react-native";
import {
  resolveDisplayHex,
  resolvePolishFinishes,
  type Polish,
  type PolishUpdateRequest,
  type PolishDupesResponse,
  type PolishStatus,
} from "swatchwatch-shared";
import {
  createManicure,
  deleteManicure,
  deletePolish,
  errorMessage,
  getPolish,
  getPolishDupes,
  updatePolish,
} from "@/api/client";
import { useAuth } from "@/auth/auth-provider";
import { EditDetailsSheet } from "@/components/edit-details-sheet";
import { GoesWith } from "@/components/goes-with";
import { NailPhotoSection } from "@/components/nail-photo-section";
import { WearHistory } from "@/components/wear-history";
import { ColorDot, Swatch } from "@/components/swatch";
import { AppText, Button, Card, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { invalidateInventoryCaches, readCache, writeCache } from "@/lib/api-cache";
import { formatBuyPriceLine } from "@/lib/buy-price";
import { notifyCollectionChanged } from "@/lib/collection-events";
import { finishLabel } from "@/lib/finishes";
import { formatWornOn } from "@/lib/mani";
import { applyEditPatch, defaultCurrency, formatPurchaseLine, initialEditForm, type PolishEditForm } from "@/lib/polish-edit";
import {
  isOwnedPolish,
  localIsoDate,
  POLISH_STATUS_LABELS,
  quickLogRole,
  statusActionsFor,
  statusChangePatch,
  type StatusAction,
} from "@/lib/status";
import { useTheme } from "@/theme/theme";

type Busy = "status" | "tried" | "mani" | "edit" | null;

/** api-cache key (per user) of the currency last saved with a purchase price. */
const LAST_CURRENCY_KEY = "last-purchase-currency";

/** Polish detail (web: `/polishes/detail?id=`): swatches, finishes, status actions, mani log. */
export default function PolishDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const [polish, setPolish] = useState<Polish | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [dupes, setDupes] = useState<PolishDupesResponse | null>(null);
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const [editForm, setEditForm] = useState<PolishEditForm | null>(null);

  const load = useCallback(async () => {
    try {
      setPolish(await getPolish(id));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Couldn't load this polish."));
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    getPolish(id)
      .then((loaded) => {
        if (!cancelled) setPolish(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Couldn't load this polish."));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // "You own N close dupes" (#265) — only interesting when this one isn't the owned bottle.
  useEffect(() => {
    if (!polish || isOwnedPolish(polish)) return;
    let cancelled = false;
    getPolishDupes(polish.id, { limit: 3 })
      .then((res) => !cancelled && setDupes(res))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [polish]);

  if (error && !polish) {
    return <CenteredState title="Couldn't load" message={error} action={<Button title="Try again" onPress={() => void load()} />} />;
  }
  if (!polish) return <CenteredState loading />;

  const finishes = resolvePolishFinishes(polish);
  const buyPriceLine = formatBuyPriceLine(polish);
  const purchaseLine = formatPurchaseLine(polish);
  const displayHex = resolveDisplayHex(polish);
  const images = [polish.swatchImageUrl, ...(polish.sourceImageUrls ?? [])].filter(
    (url, index, all): url is string => Boolean(url) && all.indexOf(url) === index,
  );

  async function runStatusAction(action: StatusAction) {
    if (!polish) return;
    setBusy("status");
    setActionError(null);
    setNotice(null);
    try {
      if (action.kind === "remove") {
        await deletePolish(polish.id);
        setNotice("Removed from your wishlist.");
        await load();
      } else {
        const updated = await updatePolish(polish.id, statusChangePatch(polish, action.status));
        setPolish(updated);
        setNotice(statusNotice(action.status));
      }
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't update this polish."));
    } finally {
      setBusy(null);
    }
  }

  /** Open the Edit details sheet, with the last-used currency as the default for a first price. */
  async function openEdit() {
    if (!polish) return;
    const lastUsed = scope ? (await readCache<string>(scope, LAST_CURRENCY_KEY))?.data : null;
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    setEditForm(initialEditForm(polish, defaultCurrency({ existing: polish.purchaseCurrency, lastUsed, locale })));
  }

  /** Optimistic save: show the edit at once, roll back (and reopen the sheet with the draft) on failure. */
  function saveEdit(patch: PolishUpdateRequest, form: PolishEditForm) {
    if (!polish) return;
    const before = polish;
    setBusy("edit");
    setEditForm(null);
    setPolish(applyEditPatch(before, patch));
    setActionError(null);
    setNotice(null);
    updatePolish(before.id, patch)
      .then(async (updated) => {
        setPolish(updated);
        setNotice("Details saved.");
        if (patch.purchaseCurrency && scope) void writeCache(scope, LAST_CURRENCY_KEY, patch.purchaseCurrency);
        if (scope) await invalidateInventoryCaches(scope);
        notifyCollectionChanged();
      })
      .catch((err: unknown) => {
        setPolish(before);
        setActionError(errorMessage(err, "Couldn't save your changes."));
        setEditForm(form);
      })
      .finally(() => setBusy(null));
  }

  async function markTriedToday() {
    if (!polish) return;
    setBusy("tried");
    setActionError(null);
    try {
      setPolish(await updatePolish(polish.id, { triedAt: localIsoDate() }));
      setNotice("Marked as tried today.");
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't mark it tried."));
    } finally {
      setBusy(null);
    }
  }

  async function logTodaysMani() {
    if (!polish) return;
    setBusy("mani");
    setActionError(null);
    try {
      const logged = await createManicure({
        wornOn: localIsoDate(),
        polishes: [{ shadeId: polish.id, role: quickLogRole(finishes) }],
      });
      const stat = logged.wearStats.find((s) => s.shadeId === polish.id);
      if (stat) {
        setPolish({ ...polish, wearCount: stat.wearCount, lastWornAt: stat.lastWornAt, triedAt: stat.triedAt, isUntried: !stat.triedAt });
      }
      setNotice(`Logged today's mani${stat ? ` · worn ${stat.wearCount}×` : ""}.`);
      Alert.alert("Logged today's mani", `${polish.brand} ${polish.name}`, [
        {
          text: "Undo",
          style: "destructive",
          onPress: () => {
            deleteManicure(logged.id)
              .then(load)
              .then(() => setNotice("Mani log undone."))
              .catch((err) => setActionError(errorMessage(err, "Couldn't undo the log.")));
          },
        },
        { text: "OK" },
      ]);
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't log the mani."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: polish.name }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
        <View style={{ flexDirection: "row", gap: theme.spacing(4), alignItems: "center" }}>
          <Swatch polish={polish} size={112} />
          <View style={{ flex: 1, gap: theme.spacing(1) }}>
            <AppText variant="small" muted>
              {polish.brand}
            </AppText>
            <AppText variant="heading" accessibilityRole="header">
              {polish.name}
            </AppText>
            {polish.collection ? (
              <AppText variant="tiny" muted>
                {polish.collection}
              </AppText>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5), marginTop: theme.spacing(1) }}>
              <Chip label={polish.status ? POLISH_STATUS_LABELS[polish.status] : "Not in your collection"} tone={polish.status === "owned" ? "success" : "default"} />
              {polish.isUntried && <Chip label="Untried" tone="brand" />}
              {isOwnedPolish(polish) && <Chip label={`${polish.quantity ?? 1} ${(polish.quantity ?? 1) === 1 ? "bottle" : "bottles"}`} />}
            </View>
          </View>
        </View>

        {images.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing(2) }}>
            {images.map((url) => (
              <Swatch key={url} imageUrl={url} hex={displayHex} size={88} />
            ))}
          </ScrollView>
        )}

        {notice && (
          <AppText variant="small" style={{ color: theme.colors.success }} accessibilityLiveRegion="polite">
            {notice}
          </AppText>
        )}
        {actionError && <ErrorBanner message={actionError} />}

        {isOwnedPolish(polish) && (
          <Card>
            <Button title="Log today's mani" variant="brand" loading={busy === "mani"} disabled={busy !== null} onPress={() => void logTodaysMani()} />
            {polish.isUntried && (
              <Button title="Mark tried today" variant="outline" loading={busy === "tried"} disabled={busy !== null} onPress={() => void markTriedToday()} />
            )}
            <AppText variant="small" muted testID="wear-stats">
              {polish.wearCount ? `Worn ${polish.wearCount}×` : "Not worn yet"}
              {polish.lastWornAt ? ` · last worn ${formatWornOn(polish.lastWornAt.slice(0, 10))}` : ""}
              {polish.triedAt ? ` · tried ${polish.triedAt.slice(0, 10)}` : " · untried"}
            </AppText>
            <Button
              title="Log a mani with this…"
              variant="outline"
              compact
              onPress={() => router.navigate({ pathname: "/manis", params: { log: polish.id } })}
            />
          </Card>
        )}

        {isOwnedPolish(polish) && <WearHistory shadeId={polish.id} wearCount={polish.wearCount ?? 0} />}

        <NailPhotoSection polish={polish} />

        <Card>
          <AppText variant="label" muted>
            {polish.status ? "Status" : "Add it"}
          </AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
            {statusActionsFor(polish.status).map((action) => (
              <Button
                key={action.kind === "status" ? action.status : "remove"}
                title={action.label}
                variant={action.kind === "remove" ? "outline" : polish.status ? "outline" : "primary"}
                compact
                disabled={busy !== null}
                loading={busy === "status"}
                onPress={() => void runStatusAction(action)}
              />
            ))}
          </View>
        </Card>

        {polish.status && (
          <Card testID="my-details">
            <AppText variant="label" muted>
              My details
            </AppText>
            {polish.rating ? (
              <AppText accessibilityLabel={`Rated ${polish.rating} out of 5`}>
                {"★".repeat(polish.rating)}
                {"☆".repeat(Math.max(0, 5 - polish.rating))}
              </AppText>
            ) : null}
            {purchaseLine ? <AppText variant="small">{purchaseLine}</AppText> : null}
            {polish.notes ? <AppText variant="small">{polish.notes}</AppText> : null}
            {!polish.rating && !purchaseLine && !polish.notes && (
              <AppText variant="small" muted>
                No rating, notes or purchase details yet.
              </AppText>
            )}
            <Button title="Edit details" variant="outline" compact disabled={busy !== null} onPress={() => void openEdit()} testID="edit-details" />
          </Card>
        )}

        {dupes && dupes.dupeCount > 0 && !isOwnedPolish(polish) && (
          <Card style={{ borderColor: theme.colors.warning }}>
            <AppText style={{ fontWeight: "600" }}>
              You own {dupes.dupeCount} close {dupes.dupeCount === 1 ? "dupe" : "dupes"}
            </AppText>
            {dupes.dupes.map((dupe) => (
              <View key={dupe.shadeId} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
                <ColorDot hex={dupe.displayHex} size={18} />
                <AppText variant="small" style={{ flex: 1 }} numberOfLines={1}>
                  {dupe.brand} — {dupe.name}
                </AppText>
                <Chip label={dupe.grade === "high" ? "Near-identical" : "Close"} tone="warning" />
              </View>
            ))}
          </Card>
        )}

        <GoesWith polish={polish} />

        <Card>
          <AppText variant="label" muted>
            Finishes
          </AppText>
          {finishes.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }}>
              {finishes.map((finish) => (
                <Chip key={finish} label={finishLabel(finish)} />
              ))}
            </View>
          ) : (
            <AppText variant="small" muted>
              No finish recorded.
            </AppText>
          )}
          <AppText variant="label" muted>
            Color
          </AppText>
          <HexRow label="Vendor" hex={polish.vendorHex} />
          <HexRow label="AI detected" hex={polish.detectedHex} />
          <HexRow label="From name" hex={polish.nameHex} />
        </Card>

        {Boolean(polish.buyUrl) && (
          <View style={{ alignItems: "center", gap: theme.spacing(0.5) }}>
            <Button title={`Buy from ${polish.brand}`} variant="ghost" onPress={() => void Linking.openURL(polish.buyUrl as string)} />
            {buyPriceLine ? (
              <AppText variant="small" muted>
                Brand price {buyPriceLine}
              </AppText>
            ) : null}
          </View>
        )}
      </ScrollView>
      {editForm && <EditDetailsSheet visible polish={polish} initialForm={editForm} onClose={() => setEditForm(null)} onSave={saveEdit} />}
    </>
  );
}

function statusNotice(status: PolishStatus): string {
  switch (status) {
    case "owned":
      return "In your collection.";
    case "wishlist":
      return "On your wishlist.";
    case "destash":
      return "Marked for destash.";
    case "archived":
      return "Archived.";
  }
}

function HexRow({ label, hex }: { label: string; hex?: string }) {
  const theme = useTheme();
  if (!hex) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
      <ColorDot hex={hex} size={18} />
      <AppText variant="small" style={{ flex: 1 }}>
        {label}
      </AppText>
      <AppText variant="small" muted selectable style={{ fontVariant: ["tabular-nums"] }}>
        {hex.toUpperCase()}
      </AppText>
    </View>
  );
}
