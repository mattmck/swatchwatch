import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, TextInput, View } from "react-native";
import type { PolishFilters } from "swatchwatch-shared";
import { HomePanel } from "@/components/home-panel";
import { PolishRow } from "@/components/polish-row";
import { AppText, Button, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { COLLECTION_PRESETS, type CollectionPreset } from "@/lib/status";
import { usePagedPolishes } from "@/lib/use-paged-polishes";
import { useTheme } from "@/theme/theme";

/** Collection tab (web: `/polishes`): status presets, text filter, infinite scroll. */
export default function CollectionScreen() {
  const theme = useTheme();
  const [preset, setPreset] = useState<CollectionPreset["key"]>("owned");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo<PolishFilters>(() => {
    const chosen = COLLECTION_PRESETS.find((p) => p.key === preset) ?? COLLECTION_PRESETS[0];
    return { ...chosen.filters, search: debounced || undefined, sortBy: "createdAt", sortOrder: "desc" };
  }, [preset, debounced]);

  const list = usePagedPolishes(filters);
  const [homeToken, setHomeToken] = useState(0);
  const refreshAll = () => {
    setHomeToken((n) => n + 1);
    list.refresh();
  };

  const header = (
    <View>
      <HomePanel refreshToken={homeToken} />
      <View style={{ gap: theme.spacing(3) }}>
        <View style={{ paddingHorizontal: theme.spacing(4) }}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Filter by brand or shade"
            placeholderTextColor={theme.colors.mutedForeground}
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
            accessibilityLabel="Filter your polishes"
            style={{
              borderWidth: 1,
              borderColor: theme.colors.input,
              borderRadius: theme.radius.lg,
              paddingHorizontal: theme.spacing(3),
              paddingVertical: theme.spacing(2.5),
              color: theme.colors.foreground,
              backgroundColor: theme.colors.card,
              fontSize: theme.font.body,
            }}
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing(2), paddingHorizontal: theme.spacing(4) }}
        >
          {COLLECTION_PRESETS.map((p) => (
            <Chip key={p.key} label={p.label} selected={p.key === preset} onPress={() => setPreset(p.key)} />
          ))}
        </ScrollView>
        {!list.loading && !list.error && (
          <AppText variant="tiny" muted style={{ paddingHorizontal: theme.spacing(4) }} testID="collection-total">
            {list.total} {list.total === 1 ? "polish" : "polishes"}
          </AppText>
        )}
        {list.error && (
          <View style={{ paddingHorizontal: theme.spacing(4) }}>
            <ErrorBanner message={list.error} onRetry={refreshAll} />
          </View>
        )}
      </View>
    </View>
  );

  return (
    <FlatList
      data={list.items}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      renderItem={({ item }) => (
        <PolishRow polish={item} onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: item.id } })} />
      )}
      ItemSeparatorComponent={() => <View style={{ height: 1, marginLeft: 84, backgroundColor: theme.colors.border }} />}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={refreshAll} tintColor={theme.colors.primary} />}
      ListFooterComponent={
        list.loadingMore ? <ActivityIndicator style={{ margin: theme.spacing(4) }} color={theme.colors.primary} /> : null
      }
      ListEmptyComponent={
        list.loading ? (
          <CenteredState loading />
        ) : list.error ? null : (
          <CenteredState
            title={debounced ? "No matches" : preset === "wishlist" ? "Your wishlist is empty" : "Nothing here yet"}
            message={
              debounced ? `Nothing in this view matches “${debounced}”.` : "Scan a bottle on the Add tab or find shades in Search."
            }
            action={<Button title="Scan a bottle" variant="outline" onPress={() => router.navigate("/add")} />}
          />
        )
      }
      contentContainerStyle={{ paddingBottom: theme.spacing(6) }}
    />
  );
}
