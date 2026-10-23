import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { useAuth } from "@/auth/auth-provider";
import { HomePanel } from "@/components/home-panel";
import { CollectionFilterBar } from "@/components/collection-filter-bar";
import { EmptyState, startCollectionActions, goTo } from "@/components/empty-state";
import { PolishRow } from "@/components/polish-row";
import { AppText, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import {
  activeFilterCount,
  clearBarFilters,
  collectionViewKey,
  parseCollectionParams,
  setPreset,
  toPolishFilters,
  type CollectionView,
  type StatusPresetKey,
} from "@/lib/collection-filters";
import { COLLECTION_PRESETS } from "@/lib/status";
import { usePagedPolishes } from "@/lib/use-paged-polishes";
import { useTheme } from "@/theme/theme";

/** Collection tab (web: `/polishes`): status presets, text filter, infinite scroll. */
export default function CollectionScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ status?: string; untried?: string; family?: string; category?: string; sort?: string }>();
  const [view, setView] = useState<CollectionView>(() => parseCollectionParams(params));
  // A deep link (`/?family=red&untried=1`) replaces the view when its params change.
  const linkKey = collectionViewKey(parseCollectionParams(params));
  const [seenLinkKey, setSeenLinkKey] = useState(linkKey);
  if (linkKey !== seenLinkKey) {
    setSeenLinkKey(linkKey);
    setView(parseCollectionParams(params));
  }
  const preset = view.preset;
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(() => toPolishFilters(view, debounced), [view, debounced]);

  const { user } = useAuth();
  const list = usePagedPolishes(filters, user ? String(user.userId) : undefined);
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
          {COLLECTION_PRESETS.map((p) => {
            // "Untried" is owned + the untried flag; "Owned" is owned without it.
            const selected = p.key === "untried" ? preset === "owned" && view.untried : p.key === preset && !(p.key === "owned" && view.untried);
            return (
              <Chip
                key={p.key}
                label={p.label}
                selected={selected}
                onPress={() =>
                  setView(
                    p.key === "untried"
                      ? { ...view, preset: "owned", untried: true }
                      : { ...setPreset(view, p.key as StatusPresetKey), untried: false },
                  )
                }
              />
            );
          })}
        </ScrollView>
        <CollectionFilterBar view={view} onChange={setView} />
        {!list.loading && !list.error && (
          <AppText variant="tiny" muted style={{ paddingHorizontal: theme.spacing(4) }} testID="collection-total">
            {list.total} {list.total === 1 ? "polish" : "polishes"}
          </AppText>
        )}
        {list.error && (
          <View style={{ paddingHorizontal: theme.spacing(4) }}>
            <ErrorBanner
              message={list.fromCache ? `${list.error} Showing your last saved list.` : list.error}
              onRetry={refreshAll}
            />
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
        ) : list.error ? null : debounced || activeFilterCount(view) > 0 ? (
          <EmptyState
            testID="collection-empty-filtered"
            title="No polishes match these filters"
            message={debounced ? `Nothing in this view matches “${debounced}”.` : "Nothing in this view matches these filters."}
            actions={[
              {
                title: "Clear filters",
                onPress: () => {
                  setSearch("");
                  setView(clearBarFilters(view));
                },
              },
            ]}
          />
        ) : preset === "wishlist" ? (
          <EmptyState
            testID="collection-empty-wishlist"
            title="Your wishlist is empty"
            message="Tap ♡ on any shade in the catalog to save it here."
            actions={[{ title: "Browse the catalog", onPress: () => goTo("/search") }]}
          />
        ) : preset === "owned" && !view.untried ? (
          <EmptyState
            testID="collection-empty"
            title="Build your collection"
            message="Add the polishes you own and they show up here."
            actions={startCollectionActions()}
          />
        ) : (
          <EmptyState
            testID="collection-empty-view"
            title="Nothing here yet"
            message="No polishes in this view yet. Add some from the catalog or scan a bottle."
            actions={[{ title: "Scan a bottle", onPress: () => router.navigate("/add") }]}
          />
        )
      }
      contentContainerStyle={{ paddingBottom: theme.spacing(6) }}
    />
  );
}
