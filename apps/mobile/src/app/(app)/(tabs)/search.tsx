import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, TextInput, View } from "react-native";
import { resolvePolishFinishes, type CatalogSearchResult, type Polish, type PolishStatus } from "swatchwatch-shared";
import { errorMessage, listPolishes, searchCatalog, updatePolish } from "@/api/client";
import { Swatch } from "@/components/swatch";
import { AppText, Button, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { confirmAddWithDupes } from "@/lib/add-guard";
import { finishLabel } from "@/lib/finishes";
import { POLISH_STATUS_LABELS, statusChangePatch } from "@/lib/status";
import { useTheme } from "@/theme/theme";

const PAGE_SIZE = 25;

/**
 * Search tab: catalog text search with one-tap Add / Wishlist. Results come from
 * `GET /api/polishes?search=` (catalog rows with the caller's status, hexes and images); when
 * that finds nothing, the fuzzy `pg_trgm` `GET /api/catalog/search` offers close spellings.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Polish[]>([]);
  const [total, setTotal] = useState(0);
  const [suggestions, setSuggestions] = useState<CatalogSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
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

  async function setStatus(polish: Polish, status: PolishStatus) {
    const choice = polish.status === "owned" ? "add" : await confirmAddWithDupes(polish.id, status === "owned" ? "owned" : "wishlist");
    if (choice === "cancel") return;
    const target: PolishStatus = choice === "wishlist" ? "wishlist" : status;
    setPending((p) => ({ ...p, [polish.id]: true }));
    // Optimistic: show the new status right away, roll back on failure.
    setResults((rows) => rows.map((r) => (r.id === polish.id ? { ...r, status: target } : r)));
    try {
      const updated = await updatePolish(polish.id, statusChangePatch(polish, target));
      setResults((rows) => rows.map((r) => (r.id === polish.id ? updated : r)));
    } catch (err) {
      setResults((rows) => rows.map((r) => (r.id === polish.id ? polish : r)));
      setError(errorMessage(err, "Couldn't update that polish."));
    } finally {
      setPending((p) => ({ ...p, [polish.id]: false }));
    }
  }

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
        {!loading && searched && results.length > 0 && (
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
          loading ? null : searched ? (
            <View style={{ padding: theme.spacing(4), gap: theme.spacing(3) }}>
              <AppText muted>No shades match “{searched}”.</AppText>
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

function SearchRow({
  polish,
  pending,
  onSetStatus,
}: {
  polish: Polish;
  pending: boolean;
  onSetStatus: (status: PolishStatus) => void;
}) {
  const theme = useTheme();
  const finishes = resolvePolishFinishes(polish);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3), paddingHorizontal: theme.spacing(4), paddingVertical: theme.spacing(3) }}>
      <Pressable
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}
        accessibilityRole="button"
        accessibilityLabel={`${polish.brand} ${polish.name}`}
        onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: polish.id } })}
      >
        <Swatch polish={polish} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="tiny" muted numberOfLines={1}>
            {polish.brand}
          </AppText>
          <AppText style={{ fontWeight: "600" }} numberOfLines={1}>
            {polish.name}
          </AppText>
          {finishes.length > 0 && (
            <AppText variant="tiny" muted numberOfLines={1}>
              {finishes.map(finishLabel).join(" · ")}
            </AppText>
          )}
        </View>
      </Pressable>
      {polish.status === "owned" ? (
        <Chip label="Owned" tone="success" />
      ) : (
        <View style={{ flexDirection: "row", gap: theme.spacing(1.5), alignItems: "center" }}>
          {polish.status && polish.status !== "wishlist" && <Chip label={POLISH_STATUS_LABELS[polish.status]} />}
          {polish.status === "wishlist" ? (
            <Chip label="♡ Wishlist" tone="brand" />
          ) : (
            <Button title="♡" variant="outline" compact disabled={pending} accessibilityLabel={`Wishlist ${polish.name}`} onPress={() => onSetStatus("wishlist")} />
          )}
          <Button title="Add" compact loading={pending} accessibilityLabel={`Add ${polish.name} to collection`} onPress={() => onSetStatus("owned")} />
        </View>
      )}
    </View>
  );
}
