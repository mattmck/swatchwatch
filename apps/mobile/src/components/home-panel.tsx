import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { Polish } from "swatchwatch-shared";
import { useAuth } from "@/auth/auth-provider";
import { readCache, writeCache } from "@/lib/api-cache";
import { createManicure, deleteManicure, errorMessage, listAllPolishes, listPolishes } from "@/api/client";
import { summarizeCollection, type CollectionSummary } from "@/lib/collection-summary";
import { createSeededRandom, pickForMe, pushPickHistory, type PickResult, type RandomSource } from "@/lib/pick-for-me";
import { localIsoDate, quickLogRole } from "@/lib/status";
import { resolvePolishFinishes } from "swatchwatch-shared";
import { useTheme } from "@/theme/theme";
import { Swatch } from "./swatch";
import { AppText, Button, Card, Chip, ErrorBanner } from "./ui";

interface HomeData {
  owned: Polish[];
  summary: CollectionSummary;
}

/**
 * Top of the Collection tab: owned / wishlist / untried counts, "Pick for me" (the web's
 * weighting) and a one-tap "Log today's mani" for the pick. `refreshToken` reloads it
 * (pull-to-refresh); the previous numbers stay on screen while it does.
 */
export function HomePanel({ refreshToken }: { refreshToken: number }) {
  const theme = useTheme();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const [data, setData] = useState<HomeData | null>(null);
  /** Saved counts shown until the fresh ones arrive (stale-while-revalidate). */
  const [savedSummary, setSavedSummary] = useState<CollectionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pick, setPick] = useState<PickResult | null>(null);
  const [noPick, setNoPick] = useState(false);
  const [logging, setLogging] = useState(false);
  const [logged, setLogged] = useState<{ id: string; label: string; before: Polish } | null>(null);
  const history = useRef<string[]>([]);
  const random = useRef<RandomSource | null>(null);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void readCache<CollectionSummary>(scope, "home-summary").then((entry) => {
      if (entry && !cancelled) setSavedSummary(entry.data);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAllPolishes({ status: ["owned"] }), listPolishes({ status: ["wishlist"], pageSize: 1 })])
      .then(([owned, wishlist]) => {
        if (cancelled) return;
        const summary = summarizeCollection(owned, wishlist.total);
        setData({ owned, summary });
        if (scope) void writeCache(scope, "home-summary", summary);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Couldn't load your collection summary."));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, scope]);

  const doPick = useCallback(() => {
    if (!data) return;
    random.current ??= createSeededRandom(Date.now());
    const result = pickForMe(data.owned, { now: Date.now(), random: random.current, exclude: history.current });
    setLogged(null);
    setNoPick(result === null);
    setPick(result);
    if (result) history.current = pushPickHistory(history.current, result.polish.id);
  }, [data]);

  async function logPick() {
    if (!pick) return;
    setLogging(true);
    setActionError(null);
    try {
      const finishes = resolvePolishFinishes(pick.polish);
      const entry = await createManicure({
        wornOn: localIsoDate(),
        polishes: [{ shadeId: pick.polish.id, role: quickLogRole(finishes) }],
      });
      const stat = entry.wearStats.find((s) => s.shadeId === pick.polish.id);
      setLogged({
        id: entry.id,
        label: `Logged today's mani${stat ? ` · worn ${stat.wearCount}×` : ""}`,
        before: pick.polish,
      });
      // Reflect the new wear stats so the next pick respects the cooldown.
      setData((prev) =>
        prev && stat
          ? {
              owned: prev.owned.map((p) =>
                p.id === pick.polish.id ? { ...p, wearCount: stat.wearCount, lastWornAt: stat.lastWornAt, triedAt: stat.triedAt, isUntried: !stat.triedAt } : p,
              ),
              summary: prev.summary,
            }
          : prev,
      );
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't log the mani."));
    } finally {
      setLogging(false);
    }
  }

  async function undoLog() {
    if (!logged) return;
    try {
      await deleteManicure(logged.id);
      // Put the pre-log row back so the cooldown and tried state match the server again.
      const { before } = logged;
      setData((prev) => (prev ? { ...prev, owned: prev.owned.map((p) => (p.id === before.id ? before : p)) } : prev));
      setLogged(null);
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't undo the log."));
    }
  }

  const summary = data?.summary ?? savedSummary ?? undefined;
  return (
    <View style={{ padding: theme.spacing(4), gap: theme.spacing(3) }}>
      <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
        <Stat label="Owned" value={summary?.owned} />
        <Stat label="Wishlist" value={summary?.wishlist} />
        <Stat label="Untried" value={summary?.untried} hint={summary?.untriedPercent != null ? `${summary.untriedPercent}%` : undefined} />
      </View>

      {/* A failed refresh with saved counts on screen is already explained by the list's banner. */}
      {error && !summary && <ErrorBanner message={error} />}
      {actionError && <ErrorBanner message={actionError} />}

      {pick ? (
        <Card testID="pick-card">
          <AppText variant="label" muted>
            Wear this today
          </AppText>
          <View style={{ flexDirection: "row", gap: theme.spacing(3), alignItems: "center" }}>
            <Swatch polish={pick.polish} size={64} />
            <View style={{ flex: 1, gap: 2 }}>
              <AppText variant="tiny" muted numberOfLines={1}>
                {pick.polish.brand}
              </AppText>
              <AppText variant="heading" numberOfLines={2}>
                {pick.polish.name}
              </AppText>
            </View>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }}>
            {pick.reasons.map((reason) => (
              <Chip key={reason.kind} label={reason.label} tone={reason.kind === "untried" ? "brand" : "default"} />
            ))}
          </View>
          {logged ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <AppText variant="small" style={{ color: theme.colors.success, flex: 1 }}>
                {logged.label}
              </AppText>
              <Button title="Undo" variant="outline" compact onPress={() => void undoLog()} />
            </View>
          ) : (
            <Button title="Log today's mani" variant="brand" loading={logging} onPress={() => void logPick()} testID="pick-log" />
          )}
          <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
            <Button title="Pick again" variant="outline" compact onPress={doPick} style={{ flex: 1 }} />
            <Button
              title="View"
              variant="outline"
              compact
              onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: pick.polish.id } })}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      ) : (
        <Button
          title={noPick ? "Nothing owned to pick from yet" : "Pick for me"}
          variant="primary"
          disabled={!data || data.owned.length === 0}
          onPress={doPick}
          testID="pick-for-me"
        />
      )}
    </View>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | undefined; hint?: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radius.lg,
        padding: theme.spacing(3),
        gap: 2,
      }}
    >
      <AppText variant="title" testID={`stat-${label.toLowerCase()}`}>
        {value === undefined ? "–" : String(value)}
      </AppText>
      <AppText variant="tiny" muted>
        {label}
        {hint ? ` · ${hint}` : ""}
      </AppText>
    </View>
  );
}
