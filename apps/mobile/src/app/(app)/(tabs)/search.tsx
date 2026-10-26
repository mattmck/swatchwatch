import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, TextInput, View } from "react-native";
import type { CatalogSearchResult, Polish } from "swatchwatch-shared";
import { errorMessage, listPolishes, searchCatalog } from "@/api/client";
import { ColorSearchPanel } from "@/components/color-search-panel";
import { SearchRow, useSetPolishStatus } from "@/components/search-row";
import { AppText, Button, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { normalizeHexParam } from "@/lib/color-search";
import { manualAddRoute } from "@/lib/manual-add";
import { useTheme } from "@/theme/theme";

const PAGE_SIZE = 25;

type SearchMode = "text" | "color";

/**
 * Search tab: a **Text | By color** switch. `hex` (`/search?hex=C0392B`, with or without `#`)
 * or `mode=color` opens By color, e.g. from the polish detail "Goes with" card.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ hex?: string; mode?: string }>();
  const linkHex = normalizeHexParam(params.hex);
  const wantsColor = Boolean(linkHex) || params.mode === "color";
  const [mode, setMode] = useState<SearchMode>(wantsColor ? "color" : "text");

  // A new deep link (tab already mounted) switches to By color; adjusted during render, not in an effect.
  const linkKey = `${linkHex ?? ""}|${params.mode ?? ""}`;
  const [seenLinkKey, setSeenLinkKey] = useState(linkKey);
  if (linkKey !== seenLinkKey) {
    setSeenLinkKey(linkKey);
    if (wantsColor) setMode("color");
  }

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flexDirection: "row", gap: theme.spacing(2), paddingHorizontal: theme.spacing(4), paddingTop: theme.spacing(3) }}
        accessibilityRole="tablist"
      >
        <Chip label="Text" selected={mode === "text"} onPress={() => setMode("text")} />
        <Chip label="By color" selected={mode === "color"} onPress={() => setMode("color")} />
      </View>
      {/* Text search stays mounted (query + results survive switching modes). */}
      <View style={{ flex: 1, display: mode === "text" ? "flex" : "none" }}>
        <TextSearch />
      </View>
      {mode === "color" && (
        <View style={{ flex: 1, paddingTop: theme.spacing(3) }}>
          <ColorSearchPanel initialHex={linkHex} />
        </View>
      )}
    </View>
  );
}

/**
 * Catalog text search with one-tap Add / Wishlist. Results come from `GET /api/polishes?search=`
 * (catalog rows with the caller's status, hexes and images); when that finds nothing, the fuzzy
 * `pg_trgm` `GET /api/catalog/search` offers close spellings.
 */
function TextSearch() {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Polish[]>([]);
  const [total, setTotal] = useState(0);
  const [suggestions, setSuggestions] = useState<CatalogSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState("");
  const generation = useRef(0);

  const run = useCallback(async (q: string) => {
    const gen = ++generation.current;
    if (!q) {
      setResults([]);
      setSuggestions([]);
      setSearched("");
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await listPolishes({ search: q, pageSize: PAGE_SIZE, sortBy: "name", sortOrder: "asc" });
      if (gen !== generation.current) return;
      setResults(res.polishes);
      setTotal(res.total);
      setSearched(q);
      setError(null);
      if (res.polishes.length === 0) {
        const fuzzy = await searchCatalog(q, { limit: 10 }).catch(() => null);
        if (gen === generation.current) setSuggestions(fuzzy?.results ?? []);
      } else {
        setSuggestions([]);
      }
    } catch (err) {
      if (gen === generation.current) setError(errorMessage(err, "Search failed."));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void run(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query, run]);

  const replace = useCallback((id: string, next: Polish) => {
    setResults((rows) => rows.map((r) => (r.id === id ? next : r)));
  }, []);
  const { pending, setStatus } = useSetPolishStatus(replace, setError);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: theme.spacing(4), gap: theme.spacing(3) }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search brands and shades"
          placeholderTextColor={theme.colors.mutedForeground}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel="Search the catalog"
          testID="search-input"
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
        <Button title="Match a photo to my collection" variant="outline" compact onPress={() => router.push("/match")} />
        {error && <ErrorBanner message={error} onRetry={() => void run(query.trim())} />}
        {loading && <ActivityIndicator color={theme.colors.primary} />}
        {!loading && Boolean(searched) && results.length > 0 && (
          <AppText variant="tiny" muted>
            {total > results.length ? `Top ${results.length} of ${total}` : `${total}`} results for “{searched}”
          </AppText>
        )}
      </View>

      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <SearchRow polish={item} pending={Boolean(pending[item.id])} onSetStatus={(s) => void setStatus(item, s)} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 1, marginLeft: 84, backgroundColor: theme.colors.border }} />}
        ListEmptyComponent={
          loading ? undefined : searched ? (
            <View style={{ padding: theme.spacing(4), gap: theme.spacing(3) }}>
              <AppText muted>No shades match “{searched}”.</AppText>
              <Button
                title="Can't find it? Add it manually"
                variant="outline"
                compact
                onPress={() => router.push(manualAddRoute({ name: searched }))}
                style={{ alignSelf: "flex-start" }}
              />
              {suggestions.length > 0 && (
                <>
                  <AppText variant="label" muted>
                    Did you mean
                  </AppText>
                  {suggestions.map((s) => (
                    <Pressable
                      key={s.shadeId}
                      accessibilityRole="button"
                      onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: s.shadeId } })}
                    >
                      <AppText style={{ color: theme.colors.primary }}>
                        {s.brand} — {s.name}
                      </AppText>
                    </Pressable>
                  ))}
                </>
              )}
            </View>
          ) : (
            <CenteredState title="Find a shade" message="Search the catalog by brand, shade or collection." />
          )
        }
        contentContainerStyle={results.length === 0 ? { flexGrow: 1 } : { paddingBottom: theme.spacing(6) }}
      />
    </View>
  );
}

