import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, SectionList, StyleSheet, View } from "react-native";
import { COLOR_FAMILIES, COLOR_FAMILY_LABELS, type ColorFamily, type Polish } from "swatchwatch-shared";
import { errorMessage, listColorPolishes, listOwnedColorPolishes } from "@/api/client";
import {
  catalogColorQuery,
  COLLECTION_FALLBACK_MIN,
  DEFAULT_LIGHTNESS_INDEX,
  gradeLabel,
  HUE_STOPS,
  LIGHTNESS_STEPS,
  pickerHex,
  rankByColor,
  toggleFamily,
  type ColorMatch,
} from "@/lib/color-search";
import { useTheme } from "@/theme/theme";
import { SearchRow, useSetPolishStatus } from "./search-row";
import { AppText, Chip, ErrorBanner } from "./ui";

type Scope = "collection" | "catalog";
/** A hue stop index into `HUE_STOPS`, or `"neutral"`. */
type HueChoice = number | "neutral";

interface Section {
  key: string;
  title: string | null;
  data: ColorMatch[];
}

/**
 * Search tab "By color" (#384): a 12-stop hue strip (+ neutral) and five lightness steps, color
 * family chips (`?family=`), and owned color polishes ranked by OKLAB distance to the picked
 * color with the dupe rule's HIGH / MEDIUM grade (a hex guessed from the color name ranks last
 * and shows "Estimated color" instead). "Catalog" switches to catalog rows, ranked
 * over the whole catalog on the server (`?nearHex=`; Add / ♡ through the add guard). With fewer than `COLLECTION_FALLBACK_MIN` owned
 * matches the catalog is listed under the collection, with a hint. `initialHex` seeds the
 * target (deep link `/search?hex=C0392B`).
 */
export function ColorSearchPanel({ initialHex }: { initialHex: string | null }) {
  const theme = useTheme();
  const [hue, setHue] = useState<HueChoice>(0);
  const [lightness, setLightness] = useState(DEFAULT_LIGHTNESS_INDEX);
  /** An exact hex from a deep link; cleared as soon as the user touches the picker. */
  const [seedHex, setSeedHex] = useState<string | null>(initialHex);
  const [families, setFamilies] = useState<ColorFamily[]>([]);
  const [scope, setScope] = useState<Scope>("collection");
  const [owned, setOwned] = useState<Polish[] | null>(null);
  const [catalog, setCatalog] = useState<Polish[] | null>(null);
  /** Request keys whose fetch has settled; loading = the current key has not settled yet. */
  const [ownedSettledKey, setOwnedSettledKey] = useState<string | null>(null);
  const [catalogSettledKey, setCatalogSettledKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // A new deep-link hex replaces the picker color (adjusting state during render, not in an effect).
  const [seenInitialHex, setSeenInitialHex] = useState(initialHex);
  if (initialHex !== seenInitialHex) {
    setSeenInitialHex(initialHex);
    if (initialHex) setSeedHex(initialHex);
  }

  const pickedHex = useMemo(
    () => seedHex ?? pickerHex(hue === "neutral" ? null : HUE_STOPS[hue], lightness),
    [seedHex, hue, lightness],
  );

  // Owned color polishes (refetched when the family chips change).
  const familyKey = families.join(",");
  const ownedRequestKey = `${familyKey}#${reloadToken}`;
  useEffect(() => {
    let cancelled = false;
    const fams = familyKey ? (familyKey.split(",") as ColorFamily[]) : [];
    listOwnedColorPolishes(fams)
      .then((rows) => {
        if (cancelled) return;
        setOwned(rows);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err, "Couldn't load your collection."));
      })
      .finally(() => {
        if (!cancelled) setOwnedSettledKey(ownedRequestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [familyKey, ownedRequestKey]);

  const ownedFallback = owned !== null && owned.length < COLLECTION_FALLBACK_MIN;
  const wantCatalog = scope === "catalog" || ownedFallback;
  const catalogRequestKey = `${pickedHex}|${familyKey}#${reloadToken}`;

  // The catalog color polishes nearest the picked color, in the selected families if any
  // (debounced: tapping through hues should not fire a query per tap).
  useEffect(() => {
    if (!wantCatalog) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const fams = familyKey ? (familyKey.split(",") as ColorFamily[]) : [];
      listColorPolishes(catalogColorQuery(pickedHex, fams))
        .then((res) => {
          if (cancelled) return;
          setCatalog(res.polishes);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(errorMessage(err, "Couldn't load catalog shades."));
        })
        .finally(() => {
          if (!cancelled) setCatalogSettledKey(catalogRequestKey);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wantCatalog, pickedHex, familyKey, catalogRequestKey]);

  const loadingOwned = ownedSettledKey !== ownedRequestKey;
  const loadingCatalog = catalogSettledKey !== catalogRequestKey;
  const error = actionError ?? loadError;

  const replace = useCallback((id: string, next: Polish) => {
    setCatalog((rows) => rows?.map((r) => (r.id === id ? next : r)) ?? rows);
    setOwned((rows) => {
      if (!rows) return rows;
      const without = rows.filter((r) => r.id !== id);
      return next.status === "owned" ? [...without, next] : without;
    });
  }, []);
  const { pending, setStatus } = useSetPolishStatus(replace, setActionError);

  const sections = useMemo<Section[]>(() => {
    const ownedMatches = owned ? rankByColor(owned, pickedHex) : [];
    if (scope === "catalog") {
      return [{ key: "catalog", title: null, data: catalog ? rankByColor(catalog, pickedHex) : [] }];
    }
    const out: Section[] = [{ key: "collection", title: ownedFallback ? "My collection" : null, data: ownedMatches }];
    if (ownedFallback && catalog) {
      const ownedIds = new Set(ownedMatches.map((m) => m.polish.id));
      const extra = rankByColor(
        catalog.filter((p) => !ownedIds.has(p.id) && p.status !== "owned"),
        pickedHex,
      );
      out.push({ key: "catalog", title: "From the catalog", data: extra });
    }
    return out;
  }, [owned, catalog, pickedHex, scope, ownedFallback]);

  const loading = loadingOwned || (wantCatalog && loadingCatalog);

  const header = (
    <View style={{ paddingHorizontal: theme.spacing(4), paddingBottom: theme.spacing(2), gap: theme.spacing(3) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
        <View
          testID="color-target"
          style={{
            width: 44,
            height: 44,
            borderRadius: theme.radius.lg,
            backgroundColor: pickedHex,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
          }}
        />
        <View style={{ flex: 1 }}>
          <AppText style={{ fontWeight: "600" }}>{pickedHex}</AppText>
          <AppText variant="tiny" muted>
            {seedHex ? "From a link · tap a color to change it" : "Pick a hue, then a shade"}
          </AppText>
        </View>
      </View>

      {/* Hue strip: 12 OKLCH hues + neutral, at the selected lightness. */}
      <View style={{ flexDirection: "row", gap: 4 }} accessibilityRole="radiogroup" accessibilityLabel="Hue">
        {[...HUE_STOPS.map((_, i) => i as HueChoice), "neutral" as const].map((choice) => {
          const hex = pickerHex(choice === "neutral" ? null : HUE_STOPS[choice], lightness);
          const selected = !seedHex && hue === choice;
          return (
            <Pressable
              key={String(choice)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={choice === "neutral" ? "Neutral" : `Hue ${HUE_STOPS[choice]} degrees`}
              onPress={() => {
                setSeedHex(null);
                setHue(choice);
              }}
              style={{
                flex: 1,
                height: 32,
                borderRadius: theme.radius.sm,
                backgroundColor: hex,
                borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                borderColor: selected ? theme.colors.foreground : theme.colors.border,
              }}
            />
          );
        })}
      </View>

      {/* Lightness: the selected hue at five lightness steps. */}
      <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Lightness">
        {LIGHTNESS_STEPS.map((_, i) => {
          const hex = pickerHex(hue === "neutral" ? null : HUE_STOPS[hue], i);
          const selected = !seedHex && lightness === i;
          return (
            <Pressable
              key={i}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={["Darkest", "Dark", "Medium", "Light", "Lightest"][i] ?? `Step ${i + 1}`}
              onPress={() => {
                setSeedHex(null);
                setLightness(i);
              }}
              style={{
                flex: 1,
                height: 28,
                borderRadius: theme.radius.pill,
                backgroundColor: hex,
                borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                borderColor: selected ? theme.colors.foreground : theme.colors.border,
              }}
            />
          );
        })}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing(1.5) }}>
        {COLOR_FAMILIES.map((family) => (
          <Chip
            key={family}
            label={COLOR_FAMILY_LABELS[family]}
            selected={families.includes(family)}
            onPress={() => setFamilies((prev) => toggleFamily(prev, family))}
          />
        ))}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: theme.spacing(2) }} accessibilityRole="tablist">
        <Chip label="My collection" selected={scope === "collection"} onPress={() => setScope("collection")} />
        <Chip label="Catalog" selected={scope === "catalog"} onPress={() => setScope("catalog")} />
      </View>

      {scope === "collection" && ownedFallback && (
        <AppText variant="tiny" muted testID="color-fallback-hint">
          {owned && owned.length === 0
            ? "None of your color polishes match these filters yet, so catalog shades are shown."
            : `Only ${owned?.length ?? 0} of your color polishes match, so catalog shades are shown too.`}
        </AppText>
      )}
      {error && (
        <ErrorBanner
          message={error}
          onRetry={() => {
            setActionError(null);
            setReloadToken((t) => t + 1);
          }}
        />
      )}
      {loading && <ActivityIndicator color={theme.colors.primary} />}
    </View>
  );

  return (
    <SectionList
      sections={sections.filter((s) => s.data.length > 0)}
      keyExtractor={(item, index) => `${item.polish.id}:${index}`}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) =>
        section.title && section.data.length > 0 ? (
          <AppText variant="label" muted style={{ paddingHorizontal: theme.spacing(4), paddingTop: theme.spacing(3) }}>
            {section.title}
          </AppText>
        ) : null
      }
      renderItem={({ item }) => (
        <SearchRow
          polish={item.polish}
          pending={Boolean(pending[item.polish.id])}
          onSetStatus={(s) => void setStatus(item.polish, s)}
          badge={<GradeChip match={item} />}
        />
      )}
      ItemSeparatorComponent={() => <View style={{ height: 1, marginLeft: 84, backgroundColor: theme.colors.border }} />}
      ListEmptyComponent={
        loading ? null : (
          <AppText muted style={{ padding: theme.spacing(4) }}>
            {families.length > 0 ? "Nothing in these color families yet." : "No color polishes to match yet."}
          </AppText>
        )
      }
      contentContainerStyle={{ paddingBottom: theme.spacing(6) }}
    />
  );
}

function GradeChip({ match }: { match: ColorMatch }) {
  if (match.estimated) return <Chip label="Estimated color" />;
  const label = gradeLabel(match.grade);
  if (!label) return null;
  return <Chip label={`${label} match`} tone={match.grade === "high" ? "success" : "warning"} />;
}
