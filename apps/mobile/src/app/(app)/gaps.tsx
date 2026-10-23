import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import type { HueFamily } from "swatchwatch-shared";
import { HUE_FAMILY_ORDER } from "swatchwatch-shared";
import { useAuth } from "@/auth/auth-provider";
import { errorMessage, listOwnedColorPolishes } from "@/api/client";
import { AppText, Button, Card, CenteredState, ErrorBanner } from "@/components/ui";
import { readCache, writeCache } from "@/lib/api-cache";
import {
  buildGapsModel,
  GAPS_MIN_OWNED,
  ownedColorHexes,
  type GapGridCell,
  type GapNextBuy,
  type GapSeverity,
} from "@/lib/gaps";
import { useTheme } from "@/theme/theme";

const HUE_SHORT: Record<HueFamily, string> = {
  reds: "Red",
  "oranges-corals": "Org",
  "yellows-golds": "Yel",
  greens: "Grn",
  "blues-teals": "Blu",
  "purples-violets": "Pur",
  "pinks-magentas": "Pnk",
  neutrals: "Neu",
};

/**
 * Collection gaps (web: `/polishes/gaps`, #109): a hue × lightness heatmap of the owned color
 * polishes (the shared rules in `color/gaps.ts`), the thinnest cells as "Next buys", and By color
 * search seeded with a cell's representative hex. The owned hexes are cached per user
 * (stale-while-revalidate), so the map opens offline.
 */
export default function GapsScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const [hexes, setHexes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void readCache<string[]>(scope, "gaps-hexes").then((entry) => {
      if (entry && !cancelled) setHexes((prev) => prev ?? entry.data);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    listOwnedColorPolishes()
      .then((owned) => {
        if (cancelled) return;
        const next = ownedColorHexes(owned);
        setHexes(next);
        setError(null);
        if (scope) void writeCache(scope, "gaps-hexes", next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Couldn't load your collection."));
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reload]);

  const retry = useCallback(() => {
    setError(null);
    setReload((n) => n + 1);
  }, []);

  const model = useMemo(() => (hexes ? buildGapsModel(hexes) : null), [hexes]);

  if (!model) {
    if (error) {
      return (
        <View style={{ padding: theme.spacing(4) }}>
          <ErrorBanner message={error} onRetry={retry} />
        </View>
      );
    }
    return <CenteredState loading title="Analyzing your collection…" />;
  }

  if (model.hexCount < GAPS_MIN_OWNED) {
    return (
      <CenteredState
        title="Your gap map needs a few more polishes"
        message={`Add at least ${GAPS_MIN_OWNED} color polishes (you have ${model.hexCount}) and this map shows the colors you have plenty of and the ones you're missing.`}
        action={
          <View style={{ gap: theme.spacing(2) }}>
            <Button title="Scan with Rapid Add" variant="primary" onPress={() => router.navigate("/add")} />
            <Button title="Search the catalog" variant="outline" onPress={() => router.navigate("/search")} />
          </View>
        }
      />
    );
  }

  const openSearch = (hex: string) => router.navigate({ pathname: "/search", params: { hex: hex.replace(/^#/, "") } });

  return (
    <ScrollView
      contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            retry();
          }}
        />
      }
    >
      {error && <ErrorBanner message={error} onRetry={retry} />}

      <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
        <Stat label="Colors" value={model.hexCount} />
        <Stat label="Missing cells" value={model.missingCount} tone="missing" />
        <Stat label="Thin cells" value={model.thinCount} tone="thin" />
      </View>

      <Card>
        <AppText variant="label" muted>
          Hue × lightness
        </AppText>
        <View style={{ flexDirection: "row", gap: 3, paddingLeft: 0 }}>
          {HUE_FAMILY_ORDER.map((hue) => (
            <View key={hue} style={{ flex: 1, alignItems: "center" }}>
              <AppText variant="tiny" muted numberOfLines={1}>
                {HUE_SHORT[hue]}
              </AppText>
            </View>
          ))}
        </View>
        {model.rows.map((row) => (
          <View key={row.lightnessLabel} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", gap: 3 }}>
              {row.cells.map((cell) => (
                <GridCell key={cell.key} cell={cell} onPress={() => openSearch(cell.seedHex)} />
              ))}
            </View>
            <AppText variant="tiny" muted>
              {row.lightnessLabel}
            </AppText>
          </View>
        ))}
        <Legend />
      </Card>

      <View style={{ gap: theme.spacing(2) }}>
        <AppText variant="heading">What to add next</AppText>
        {model.nextBuys.length === 0 ? (
          <AppText muted>Nice coverage. No missing or thin cells right now.</AppText>
        ) : (
          model.nextBuys.map((buy) => <NextBuyRow key={buy.key} buy={buy} onFind={() => openSearch(buy.seedHex)} />)
        )}
      </View>
    </ScrollView>
  );
}

function severityStyle(theme: ReturnType<typeof useTheme>, severity: GapSeverity) {
  if (severity === "missing") return { borderColor: theme.colors.destructive, borderStyle: "dashed" as const };
  if (severity === "thin") return { borderColor: theme.colors.warning, borderStyle: "solid" as const };
  return { borderColor: theme.colors.border, borderStyle: "solid" as const };
}

function GridCell({ cell, onPress }: { cell: GapGridCell; onPress: () => void }) {
  const theme = useTheme();
  const severityLabel = cell.severity === "missing" ? "missing" : cell.severity === "thin" ? "thin" : "covered";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${cell.hueLabel}, ${cell.lightnessLabel}: ${cell.count} polishes, ${severityLabel}`}
      accessibilityHint="Search the catalog for this color"
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        aspectRatio: 1,
        borderRadius: theme.radius.sm,
        borderWidth: cell.severity === "healthy" ? 0 : 1.5,
        ...severityStyle(theme, cell.severity),
        backgroundColor: theme.colors.card,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        pointerEvents="none"
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: cell.seedHex, opacity: cell.tintOpacity }}
      />
      <AppText
        variant="tiny"
        style={{
          fontWeight: "700",
          color: cell.severity === "healthy" && cell.tintOpacity > 0.75 ? "#ffffff" : theme.colors.foreground,
          textShadowColor: cell.severity === "healthy" ? "#00000066" : undefined,
          textShadowRadius: 2,
        }}
      >
        {cell.count}
      </AppText>
    </Pressable>
  );
}

function Legend() {
  const theme = useTheme();
  const items: { label: string; severity: GapSeverity }[] = [
    { label: "Missing", severity: "missing" },
    { label: "Thin", severity: "thin" },
    { label: "Covered", severity: "healthy" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: theme.spacing(4) }} accessibilityLabel="Legend: missing, thin, covered">
      {items.map((item) => (
        <View key={item.severity} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(1.5) }}>
          <View
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              borderWidth: item.severity === "healthy" ? 0 : 1.5,
              ...severityStyle(theme, item.severity),
              backgroundColor: item.severity === "healthy" ? theme.colors.primary : "transparent",
            }}
          />
          <AppText variant="tiny" muted>
            {item.label}
          </AppText>
        </View>
      ))}
    </View>
  );
}

function NextBuyRow({ buy, onFind }: { buy: GapNextBuy; onFind: () => void }) {
  const theme = useTheme();
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radius.md,
            backgroundColor: buy.seedHex,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        />
        <View style={{ flex: 1, gap: 1 }}>
          <AppText style={{ fontWeight: "600" }}>
            {buy.hueLabel} · {buy.lightnessLabel}
          </AppText>
          <AppText variant="tiny" muted>
            {buy.severity === "missing" ? "None yet" : `Only ${buy.count} so far`}
          </AppText>
        </View>
        <Button title="Find in catalog" variant="outline" compact onPress={onFind} />
      </View>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "missing" | "thin" }) {
  const theme = useTheme();
  const color = tone === "missing" ? theme.colors.destructive : tone === "thin" ? theme.colors.warning : theme.colors.foreground;
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
      <AppText variant="title" style={{ color }}>
        {value}
      </AppText>
      <AppText variant="tiny" muted>
        {label}
      </AppText>
    </View>
  );
}
