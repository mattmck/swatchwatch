import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, RefreshControl, View } from "react-native";
import type { Manicure, ManicureListResponse, Polish } from "swatchwatch-shared";
import { useAuth } from "@/auth/auth-provider";
import { readCache, writeCache } from "@/lib/api-cache";
import { deleteManicure, errorMessage, getPolish, listManicures } from "@/api/client";
import { LogManiSheet } from "@/components/log-mani-sheet";
import { ColorDot } from "@/components/swatch";
import { AppText, Button, Card, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { entryFromManicurePolish, formatWornOn, ROLE_LABELS } from "@/lib/mani";
import { useTheme } from "@/theme/theme";

const PAGE_SIZE = 20;

/** Manis tab (web: `/manis`): the mani log, newest first, with a "Log a mani" sheet. */
export default function ManisScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const { log } = useLocalSearchParams<{ log?: string }>();
  /** Serializes saved-copy updates after deletes. */
  const cacheUpdates = useRef<Promise<void>>(Promise.resolve());
  const [items, setItems] = useState<Manicure[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [preselected, setPreselected] = useState<Polish | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((res: ManicureListResponse, nextPage: number) => {
    setTotal(res.total);
    setPage(nextPage);
    setItems((prev) => {
      if (nextPage === 1) return res.manicures;
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...res.manicures.filter((m) => !seen.has(m.id))];
    });
    setError(null);
    if (nextPage === 1 && scope) void writeCache(scope, "manis", { items: res.manicures, total: res.total });
  }, [scope]);

  /**
   * Request version: every page-1 load (including the first one) starts a new one, and only the
   * latest version may change the list, the error or the loading state, so a slow older
   * response can't overwrite a newer result. "Load more" belongs to the version it started in.
   */
  const requestVersion = useRef(0);

  const load = useCallback(
    (nextPage: number): Promise<void> => {
      const version = nextPage === 1 ? ++requestVersion.current : requestVersion.current;
      const isCurrent = () => version === requestVersion.current;
      return listManicures({ page: nextPage, pageSize: PAGE_SIZE })
        .then((res) => {
          if (isCurrent()) apply(res, nextPage);
        })
        .catch((err: unknown) => {
          if (isCurrent()) setError(errorMessage(err, "Couldn't load your manis."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    },
    [apply],
  );

  useEffect(() => {
    let cancelled = false;
    let freshArrived = false;
    // Saved page 1 first (stale-while-revalidate), unless the fresh one already landed.
    if (scope) {
      void readCache<{ items: Manicure[]; total: number }>(scope, "manis").then((entry) => {
        if (!entry || cancelled || freshArrived) return;
        setItems(entry.data.items);
        setTotal(entry.data.total);
        setPage(1);
        setLoading(false);
      });
    }
    const version = ++requestVersion.current;
    const isCurrent = () => !cancelled && version === requestVersion.current;
    listManicures({ page: 1, pageSize: PAGE_SIZE })
      .then((res) => {
        freshArrived = true;
        if (isCurrent()) apply(res, 1);
      })
      .catch((err: unknown) => isCurrent() && setError(errorMessage(err, "Couldn't load your manis.")))
      .finally(() => isCurrent() && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [apply, scope]);

  // `/manis?log=<shadeId>` (from a polish) opens the sheet with that polish selected.
  useEffect(() => {
    if (!log) return;
    let cancelled = false;
    getPolish(log)
      .then((polish) => {
        if (cancelled) return;
        setPreselected(polish);
        setSheetOpen(true);
        router.setParams({ log: undefined });
      })
      .catch(() => router.setParams({ log: undefined }));
    return () => {
      cancelled = true;
    };
  }, [log]);

  function confirmDelete(mani: Manicure) {
    Alert.alert("Delete this mani?", `${formatWornOn(mani.wornOn)}. Wear counts are recalculated.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteManicure(mani.id)
            .then(() => {
              setItems((prev) => prev.filter((m) => m.id !== mani.id));
              setTotal((t) => Math.max(0, t - 1));
              // Drop it from the saved copy right away (the reload below may fail offline),
              // then reload page 1 to reset paging offsets.
              // Updates are chained so overlapping deletes each start from the latest copy.
              cacheUpdates.current = cacheUpdates.current
                .then(async () => {
                  if (!scope) return;
                  const entry = await readCache<{ items: Manicure[]; total: number }>(scope, "manis");
                  if (!entry) return;
                  await writeCache(scope, "manis", {
                    items: entry.data.items.filter((m) => m.id !== mani.id),
                    total: Math.max(0, entry.data.total - 1),
                  });
                })
                .then(() => load(1));
            })
            .catch((err: unknown) => setError(errorMessage(err, "Couldn't delete that mani.")));
        },
      },
    ]);
  }

  const hasMore = items.length < total;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(3) }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.colors.primary}
            onRefresh={() => {
              setRefreshing(true);
              void load(1).finally(() => setRefreshing(false));
            }}
          />
        }
        onEndReached={() => {
          if (loading || loadingMore || !hasMore) return;
          setLoadingMore(true);
          void load(page + 1).finally(() => setLoadingMore(false));
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={{ gap: theme.spacing(3) }}>
            <Button
              title="Log a mani"
              variant="brand"
              onPress={() => {
                setPreselected(null);
                setSheetOpen(true);
              }}
              testID="log-mani-open"
            />
            {notice && (
              <AppText variant="small" style={{ color: theme.colors.success }}>
                {notice}
              </AppText>
            )}
            {error && <ErrorBanner message={error} onRetry={() => void load(1)} />}
          </View>
        }
        renderItem={({ item }) => <ManiCard mani={item} onDelete={() => confirmDelete(item)} />}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={theme.colors.primary} /> : null}
        ListEmptyComponent={
          loading ? (
            <CenteredState loading />
          ) : error ? null : (
            <CenteredState title="No manis yet" message="Log what you wear and your polishes' wear counts fill in." />
          )
        }
      />
      <LogManiSheet
        visible={sheetOpen}
        initialPolish={preselected}
        onClose={() => setSheetOpen(false)}
        onLogged={(mani) => {
          setSheetOpen(false);
          setNotice(`Logged ${formatWornOn(mani.wornOn).toLowerCase()}'s mani.`);
          void load(1);
        }}
      />
    </View>
  );
}

function ManiCard({ mani, onDelete }: { mani: Manicure; onDelete: () => void }) {
  const theme = useTheme();
  return (
    <Card testID="mani-card">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <AppText variant="heading">{formatWornOn(mani.wornOn)}</AppText>
        <Button title="Delete" variant="ghost" compact onPress={onDelete} accessibilityLabel={`Delete mani from ${mani.wornOn}`} />
      </View>
      {mani.polishes.map((polish) => (
        <View key={`${polish.shadeId}:${polish.role}`} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
          <ColorDot hex={entryFromManicurePolish(polish).hex} size={20} />
          <AppText variant="small" style={{ flex: 1 }} numberOfLines={1}>
            {polish.brand} — {polish.name}
          </AppText>
          {polish.role !== "color" && <Chip label={ROLE_LABELS[polish.role]} />}
        </View>
      ))}
      {mani.notes ? (
        <AppText variant="small" muted>
          {mani.notes}
        </AppText>
      ) : null}
    </Card>
  );
}
