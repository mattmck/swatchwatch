import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { resolveProductCategory, type Polish } from "swatchwatch-shared";
import { listOwnedColorPolishes } from "@/api/client";
import { polishHex } from "@/lib/color-search";
import { goesWithTargets, hexRouteParam, type GoesWithTarget } from "@/lib/goes-with";
import { useTheme } from "@/theme/theme";
import { ColorDot, Swatch } from "./swatch";
import { AppText, Card } from "./ui";

/**
 * Polish detail "Goes with" (#384): complementary / analogous / triadic targets for a color
 * polish (shared harmony rules). Each target shows the closest owned color polish within the
 * Pair it radius (tap → its detail), or else the target color with "Find in catalog", which
 * opens Search → By color on that hex. Hidden for non-color products and near-neutral shades.
 */
export function GoesWith({ polish }: { polish: Polish }) {
  const theme = useTheme();
  const hex = polishHex(polish);
  const isColor = resolveProductCategory(polish.productCategory) === "color";
  const [owned, setOwned] = useState<{ forId: string; rows: Polish[] } | null>(null);

  useEffect(() => {
    if (!isColor || !hex) return;
    let cancelled = false;
    listOwnedColorPolishes()
      // A failed load still shows the targets with catalog links.
      .catch(() => [] as Polish[])
      .then((rows) => {
        if (!cancelled) setOwned({ forId: polish.id, rows });
      });
    return () => {
      cancelled = true;
    };
  }, [polish.id, isColor, hex]);

  const ready = owned?.forId === polish.id;
  const targets = useMemo(
    () => (isColor ? goesWithTargets(hex, ready && owned ? owned.rows : [], polish.id) : []),
    [isColor, hex, ready, owned, polish.id],
  );
  if (targets.length === 0) return null;

  return (
    <Card testID="goes-with">
      <AppText variant="label" muted>
        Goes with
      </AppText>
      {!ready ? (
        <ActivityIndicator color={theme.colors.primary} />
      ) : (
        targets.map((target) => <TargetRow key={target.key} target={target} />)
      )}
    </Card>
  );
}

function TargetRow({ target }: { target: GoesWithTarget }) {
  const theme = useTheme();
  const { match } = target;
  if (match) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${target.label}: ${match.polish.brand} ${match.polish.name}`}
        onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: match.polish.id } })}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: theme.spacing(3), opacity: pressed ? 0.7 : 1 })}
      >
        <ColorDot hex={target.targetHex} size={14} />
        <Swatch polish={match.polish} size={40} />
        <View style={{ flex: 1 }}>
          <AppText variant="tiny" muted numberOfLines={1}>
            {target.label} · you own it
          </AppText>
          <AppText variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
            {match.polish.brand} — {match.polish.name}
          </AppText>
        </View>
      </Pressable>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
      <ColorDot hex={target.targetHex} size={14} />
      <Swatch hex={target.targetHex} size={40} />
      <View style={{ flex: 1 }}>
        <AppText variant="tiny" muted numberOfLines={1}>
          {target.label} · {target.targetHex}
        </AppText>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Find ${target.label.toLowerCase()} ${target.targetHex} in the catalog`}
          onPress={() => router.navigate({ pathname: "/search", params: { hex: hexRouteParam(target.targetHex) } })}
        >
          <AppText variant="small" style={{ color: theme.colors.primary, fontWeight: "600" }}>
            Find in catalog
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}
