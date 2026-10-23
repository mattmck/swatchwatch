import { useState } from "react";
import { Pressable, ScrollView, Switch, View } from "react-native";
import {
  COLOR_FAMILIES,
  COLOR_FAMILY_LABELS,
  COLOR_FAMILY_SWATCH_HEX,
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
} from "swatchwatch-shared";
import {
  activeFilterCount,
  clearBarFilters,
  COLLECTION_SORTS,
  toggleInList,
  type CollectionView,
} from "@/lib/collection-filters";
import { useTheme } from "@/theme/theme";
import { ColorDot } from "./swatch";
import { AppText, Chip } from "./ui";

/**
 * Collapsible filter bar for the Collection tab (web: the `/polishes` family / Category chips,
 * Untried toggle and sort menu). Collapsed it shows one "Filters" row with the active count and
 * Clear; the bar opens by itself when a deep link arrives with filters set.
 */
export function CollectionFilterBar({
  view,
  onChange,
}: {
  view: CollectionView;
  onChange: (next: CollectionView) => void;
}) {
  const theme = useTheme();
  const count = activeFilterCount(view);
  const [open, setOpen] = useState(count > 0);
  const [seenCount, setSeenCount] = useState(count);
  // A deep link that sets filters while the bar is closed opens it (render-time state update).
  if (count !== seenCount) {
    setSeenCount(count);
    if (count > 0 && seenCount === 0) setOpen(true);
  }
  // Accessories are listed only when selected (a deep link); the web shows all six.
  const categories = PRODUCT_CATEGORIES.filter((c) => c !== "accessory" || view.categories.includes(c));

  return (
    <View style={{ gap: theme.spacing(2) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3), paddingHorizontal: theme.spacing(4) }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={count > 0 ? `Filters, ${count} active` : "Filters"}
          onPress={() => setOpen((o) => !o)}
          testID="filters-toggle"
        >
          <AppText variant="small" style={{ fontWeight: "600", color: theme.colors.primary }}>
            {open ? "Hide filters" : "Filters"}
            {count > 0 ? ` (${count})` : ""}
          </AppText>
        </Pressable>
        {count > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear filters" onPress={() => onChange(clearBarFilters(view))}>
            <AppText variant="small" muted>
              Clear
            </AppText>
          </Pressable>
        )}
      </View>
      {open && (
        <View style={{ gap: theme.spacing(3) }} testID="filters-panel">
          <AppText variant="label" muted style={{ paddingHorizontal: theme.spacing(4) }}>
            Color
          </AppText>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing(2), paddingHorizontal: theme.spacing(4) }}
          >
            {COLOR_FAMILIES.map((family) => {
              const selected = view.families.includes(family);
              return (
                <Pressable
                  key={family}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${COLOR_FAMILY_LABELS[family]} family`}
                  onPress={() => onChange({ ...view, families: toggleInList(view.families, family, COLOR_FAMILIES) })}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: theme.radius.pill,
                    backgroundColor: selected ? theme.colors.primary : theme.colors.secondary,
                  }}
                >
                  <ColorDot hex={COLOR_FAMILY_SWATCH_HEX[family]} size={12} />
                  <AppText
                    variant="tiny"
                    style={{ fontWeight: "600", color: selected ? theme.colors.primaryForeground : theme.colors.secondaryForeground }}
                  >
                    {COLOR_FAMILY_LABELS[family]}
                  </AppText>
                </Pressable>
              );
            })}
          </ScrollView>

          <AppText variant="label" muted style={{ paddingHorizontal: theme.spacing(4) }}>
            Category
          </AppText>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing(2), paddingHorizontal: theme.spacing(4) }}
          >
            <Chip label="Any" selected={view.categories.length === 0} onPress={() => onChange({ ...view, categories: [] })} />
            {categories.map((category) => (
              <Chip
                key={category}
                label={PRODUCT_CATEGORY_LABELS[category]}
                selected={view.categories.includes(category)}
                onPress={() =>
                  onChange({ ...view, categories: toggleInList(view.categories, category, PRODUCT_CATEGORIES) })
                }
              />
            ))}
          </ScrollView>

          {view.preset === "owned" && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: theme.spacing(4),
              }}
            >
              <AppText variant="small">Untried only</AppText>
              <Switch
                value={view.untried}
                onValueChange={(untried) => onChange({ ...view, untried })}
                accessibilityLabel="Untried only"
              />
            </View>
          )}

          <AppText variant="label" muted style={{ paddingHorizontal: theme.spacing(4) }}>
            Sort by
          </AppText>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing(2), paddingHorizontal: theme.spacing(4) }}
          >
            {COLLECTION_SORTS.map((sort) => (
              <Chip
                key={sort.key}
                label={sort.label}
                selected={view.sort === sort.key}
                onPress={() => onChange({ ...view, sort: sort.key })}
              />
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
