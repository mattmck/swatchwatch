import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import {
  POLISH_STATUSES,
  type CollectionStatsResponse,
  type CostPerWearEntry,
  type CollectionStatsShade,
} from "swatchwatch-shared";
import { errorMessage, getCollectionStats } from "@/api/client";
import { useAuth } from "@/auth/auth-provider";
import { promptCollectionExport, useCollectionExport } from "@/components/export-collection";
import { Swatch } from "@/components/swatch";
import { EmptyState, startCollectionActions } from "@/components/empty-state";
import { AppText, Button, Card, Chip, ErrorBanner } from "@/components/ui";
import { readCache, writeCache } from "@/lib/api-cache";
import {
  barPercent,
  currencyKey,
  currencyLabel,
  currencyOptions,
  findCostPerWear,
  findSpend,
  formatMoney,
  formatMonthShort,
  formatMonthYear,
  formatWornDate,
  nothingBought,
  polishCount,
  resolveCurrencyKey,
  sharePercent,
  statsDisplayHex,
} from "@/lib/insights";
import { POLISH_STATUS_LABELS } from "@/lib/status";
import { useWishlistValue } from "@/lib/use-wishlist-value";
import type { WishlistValueView } from "@/lib/wishlist-value";
import { useTheme } from "@/theme/theme";

/** api-cache key for the last stats response (per user, wiped on sign-out). */
const STATS_CACHE_KEY = "collection-stats";

/**
 * Insights (web: the dashboard's Collection stats, #271): spend by brand and by month, worn vs
 * waiting with the untried share, cost per wear and most worn, from `GET /api/stats/collection`.
 * Money is shown per currency group (one chip per currency), never summed or converted (D6).
 * The last response is cached per user and shown at once; every focus refetches, so polish and
 * mani-log changes made elsewhere show up when the user comes back. The header exports the
 * collection through the share sheet.
 */
export default function InsightsScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const [stats, setStats] = useState<CollectionStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);
  const generation = useRef(0);
  const [wishlistToken, setWishlistToken] = useState(0);
  const wishlistValue = useWishlistValue(scope ?? undefined, true, wishlistToken);
  const exporter = useCollectionExport();

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void readCache<CollectionStatsResponse>(scope, STATS_CACHE_KEY).then((entry) => {
      // Never replace a fresh response that arrived first.
      if (entry && !cancelled) setStats((current) => current ?? entry.data);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setWishlistToken((n) => n + 1);
    setLoading(true);
    setError(null);
    try {
      const fresh = await getCollectionStats();
      if (gen !== generation.current) return;
      setStats(fresh);
      if (scope) void writeCache(scope, STATS_CACHE_KEY, fresh);
    } catch (err) {
      if (gen === generation.current) setError(errorMessage(err, "Couldn't load your collection stats."));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [scope]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const currencies = useMemo(() => (stats ? currencyOptions(stats) : []), [stats]);
  const currency = resolveCurrencyKey(currencies, selectedCurrency);
  const empty = stats !== null && nothingBought(stats);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Button
              title={exporter.exporting ? "Exporting…" : "Export"}
              variant="ghost"
              compact
              disabled={exporter.exporting}
              accessibilityLabel="Export collection"
              onPress={() => promptCollectionExport((format) => void exporter.run(format))}
              testID="insights-export"
            />
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}
        refreshControl={<RefreshControl refreshing={loading && stats !== null} onRefresh={() => void load()} />}
      >
        {exporter.error && <ErrorBanner message={exporter.error} />}
        {exporter.notice && (
          <AppText variant="small" style={{ color: theme.colors.success }}>
            {exporter.notice}
          </AppText>
        )}
        {error && (
          <ErrorBanner
            message={stats ? `${error} Showing your last saved stats.` : error}
            onRetry={() => void load()}
          />
        )}

        {stats && (
          <AppText variant="small" muted testID="insights-totals">
            {POLISH_STATUSES.map((s) => `${stats.totals.byStatus[s]} ${POLISH_STATUS_LABELS[s].toLowerCase()}`).join(" · ")}
          </AppText>
        )}

        {!stats && error ? null : empty ? (
          <EmptyState
            testID="insights-empty"
            title="Stats fill in as you go"
            message="Spend by brand and month, what you wear most and cost per wear appear here once you add polishes you own."
            actions={startCollectionActions()}
          />
        ) : (
          <>
            {currencies.length > 1 && (
              <View accessibilityLabel="Currency" style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }}>
                {currencies.map((c) => (
                  <Chip
                    key={currencyKey(c)}
                    label={currencyLabel(c)}
                    selected={currencyKey(c) === currency}
                    onPress={() => setSelectedCurrency(currencyKey(c))}
                  />
                ))}
              </View>
            )}
            <SpendByBrandPanel stats={stats} currency={currency} />
            <SpendByMonthPanel stats={stats} currency={currency} />
            <WornVsWaitingPanel stats={stats} />
            <CostPerWearPanel stats={stats} currency={currency} />
            <MostWornPanel stats={stats} />
          </>
        )}
        {/* Independent of purchase stats: a wishlist-only user sees it too. */}
        {!(!stats && error) && <WishlistPanel value={wishlistValue} />}
      </ScrollView>
    </>
  );
}

// ── Panels ──────────────────────────────────────────────────────────────────

function Panel({
  title,
  description,
  loading,
  testID,
  children,
}: {
  title: string;
  description?: string;
  loading: boolean;
  testID?: string;
  children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Card testID={testID}>
      <View style={{ gap: 2 }}>
        <AppText variant="heading">{title}</AppText>
        {description ? (
          <AppText variant="small" muted>
            {description}
          </AppText>
        ) : null}
      </View>
      {loading ? (
        <View accessibilityLabel="Loading" style={{ gap: theme.spacing(2) }}>
          {[80, 60, 45, 30].map((width) => (
            <View
              key={width}
              style={{ height: 14, width: `${width}%`, borderRadius: theme.radius.sm, backgroundColor: theme.colors.muted }}
            />
          ))}
        </View>
      ) : (
        children
      )}
    </Card>
  );
}

function PanelEmpty({ message }: { message: string }) {
  return (
    <AppText variant="small" muted>
      {message}
    </AppText>
  );
}

/** Horizontal bar with a label above it, width proportional to the panel's largest value. */
function BarRow({ label, value, percent, hint }: { label: string; value: string; percent: number; hint?: string }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}${hint ? `, ${hint}` : ""}`} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.spacing(2) }}>
        <AppText variant="small" numberOfLines={1} style={{ flex: 1 }}>
          {label}
        </AppText>
        <AppText variant="small" style={{ fontWeight: "600" }}>
          {value}
        </AppText>
      </View>
      <View style={{ height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.colors.muted, overflow: "hidden" }}>
        <View style={{ height: 8, width: `${percent}%`, borderRadius: theme.radius.pill, backgroundColor: theme.colors.primary }} />
      </View>
      {hint ? (
        <AppText variant="tiny" muted>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

function SpendByBrandPanel({ stats, currency }: { stats: CollectionStatsResponse | null; currency: string }) {
  const group = stats ? findSpend(stats, currency) : undefined;
  const label = group ? currencyLabel(group.currency) : null;
  const max = group ? Math.max(0, ...group.byBrand.map((b) => b.total)) : 0;
  return (
    <Panel
      title="Spend by brand"
      description={group && label ? `All-time, ${label}` : "Where your polish money goes"}
      loading={!stats}
      testID="panel-spend-brand"
    >
      {stats && !group ? (
        <PanelEmpty
          message={
            stats.spend.currencies.length === 0
              ? "Add a purchase price to your polishes to see spend by brand."
              : "No purchases recorded in this currency."
          }
        />
      ) : group ? (
        <>
          <AppText variant="title">{formatMoney(group.total, group.currency)}</AppText>
          {group.byBrand.map((entry) => (
            <BarRow
              key={entry.isOther ? "__other" : entry.brand}
              label={entry.isOther ? `Other (${entry.brandCount} brands)` : entry.brand}
              value={formatMoney(entry.total, group.currency)}
              percent={barPercent(entry.total, max)}
              hint={polishCount(entry.itemCount)}
            />
          ))}
          {stats && stats.spend.unpricedCount > 0 ? (
            <AppText variant="tiny" muted>
              {polishCount(stats.spend.unpricedCount)} without a price {stats.spend.unpricedCount === 1 ? "is" : "are"} left out.
            </AppText>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function SpendByMonthPanel({ stats, currency }: { stats: CollectionStatsResponse | null; currency: string }) {
  const theme = useTheme();
  const group = stats ? findSpend(stats, currency) : undefined;
  const label = group ? currencyLabel(group.currency) : null;
  const months = group?.byMonth ?? [];
  const hasSpend = months.some((m) => m.total > 0);
  const max = Math.max(0, ...months.map((m) => m.total));
  const windowTotal = months.reduce((sum, m) => sum + m.total, 0);
  const estimated = months.reduce((sum, m) => sum + m.estimatedDateCount, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = months.find((m) => m.month === selected) ?? [...months].reverse().find((m) => m.total > 0);
  return (
    <Panel
      title="Spend by month"
      description={group && label ? `Last 12 months, ${label}` : "Your polish spending over the last year"}
      loading={!stats}
      testID="panel-spend-month"
    >
      {stats && (!group || !hasSpend) ? (
        <PanelEmpty
          message={
            group
              ? "No purchases in the last 12 months in this currency."
              : "Add a purchase price (and date) to your polishes to see monthly spend."
          }
        />
      ) : group ? (
        <>
          <AppText variant="title">{formatMoney(windowTotal, group.currency)}</AppText>
          <View style={{ flexDirection: "row", alignItems: "flex-end", height: 120, gap: 3 }}>
            {months.map((m) => {
              const active = shown?.month === m.month;
              return (
                <Pressable
                  key={m.month}
                  accessibilityRole="button"
                  accessibilityLabel={`${formatMonthYear(m.month)}: ${formatMoney(m.total, group.currency)}, ${polishCount(m.itemCount)}`}
                  onPress={() => setSelected(m.month)}
                  style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}
                >
                  <View
                    style={{
                      height: `${barPercent(m.total, max)}%`,
                      borderTopLeftRadius: theme.radius.sm,
                      borderTopRightRadius: theme.radius.sm,
                      backgroundColor: active ? theme.colors.brand.pink : theme.colors.primary,
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: "row", gap: 3 }}>
            {months.map((m, i) => (
              <AppText key={m.month} variant="tiny" muted style={{ flex: 1, textAlign: "center", fontSize: 9 }}>
                {(months.length - 1 - i) % 2 === 0 ? formatMonthShort(m.month) : ""}
              </AppText>
            ))}
          </View>
          {shown ? (
            <AppText variant="small">
              {formatMonthYear(shown.month)}: {formatMoney(shown.total, group.currency)} · {polishCount(shown.itemCount)}
            </AppText>
          ) : null}
          {estimated > 0 ? (
            <AppText variant="tiny" muted>
              {polishCount(estimated)} without a purchase date {estimated === 1 ? "is" : "are"} counted in the month added.
            </AppText>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function WornVsWaitingPanel({ stats }: { stats: CollectionStatsResponse | null }) {
  const theme = useTheme();
  const worn = stats?.wornVsWaiting.worn ?? 0;
  const waiting = stats?.wornVsWaiting.waiting ?? 0;
  const owned = worn + waiting;
  const wornPercent = sharePercent(worn, owned);
  return (
    <Panel
      title="Worn vs waiting"
      description="Owned polishes you've worn at least once"
      loading={!stats}
      testID="panel-worn"
    >
      {stats && owned === 0 ? (
        <PanelEmpty message="Add polishes you own to see how much of your collection gets worn." />
      ) : stats ? (
        <>
          <AppText variant="title">{wornPercent ?? 0}% worn</AppText>
          <View
            accessible
            accessibilityLabel={`${worn} worn, ${waiting} waiting`}
            style={{ flexDirection: "row", height: 14, borderRadius: theme.radius.pill, overflow: "hidden", backgroundColor: theme.colors.muted }}
          >
            <View style={{ width: `${barPercent(worn, owned, 0)}%`, backgroundColor: theme.colors.primary }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="small">Worn: {worn}</AppText>
            <AppText variant="small" muted>
              Waiting (never worn): {waiting}
            </AppText>
          </View>
          {stats.untried.percent !== null ? (
            <AppText variant="small" muted>
              {stats.untried.untried} of {stats.untried.owned} owned untried ({stats.untried.percent}%)
            </AppText>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function CostPerWearPanel({ stats, currency }: { stats: CollectionStatsResponse | null; currency: string }) {
  const group = stats ? findCostPerWear(stats, currency) : undefined;
  const label = group ? currencyLabel(group.currency) : null;
  return (
    <Panel
      title="Cost per wear"
      description={label ? `Price ÷ manis logged, ${label}` : "Price ÷ manis logged"}
      loading={!stats}
      testID="panel-cost-per-wear"
    >
      {stats && (!group || group.best.length === 0) ? (
        <PanelEmpty
          message={
            group && group.pricedUnwornCount > 0
              ? `${polishCount(group.pricedUnwornCount)} with a price ${group.pricedUnwornCount === 1 ? "hasn't" : "haven't"} been worn yet. Log a mani to see cost per wear.`
              : "Add a purchase price and log a mani to see cost per wear."
          }
        />
      ) : group ? (
        <>
          <CostList title="Best value" entries={group.best} currency={group.currency} />
          {group.worst.length > 0 && <CostList title="Worst value" entries={group.worst} currency={group.currency} />}
          {group.pricedUnwornCount > 0 ? (
            <AppText variant="tiny" muted>
              {polishCount(group.pricedUnwornCount)} with a price not worn yet.
            </AppText>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function CostList({ title, entries, currency }: { title: string; entries: CostPerWearEntry[]; currency: string | null }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(2) }}>
      <AppText variant="label" muted>
        {title}
      </AppText>
      {entries.map((entry) => (
        <ShadeRow
          key={entry.inventoryItemId}
          shade={entry}
          detail={`${formatMoney(entry.price, currency)} · ${entry.wearCount}× worn`}
          value={`${formatMoney(entry.costPerWear, currency)}/wear`}
        />
      ))}
    </View>
  );
}

function MostWornPanel({ stats }: { stats: CollectionStatsResponse | null }) {
  return (
    <Panel title="Most worn" description="Your top 10 by manis logged" loading={!stats} testID="panel-most-worn">
      {stats && stats.mostWorn.length === 0 ? (
        <PanelEmpty message="Log a mani to start tracking your most-worn polishes." />
      ) : (
        stats?.mostWorn.map((entry, i) => (
          <ShadeRow
            key={entry.inventoryItemId}
            rank={i + 1}
            shade={entry}
            detail={`Last worn ${formatWornDate(entry.lastWornAt)}`}
            value={`${entry.wearCount}×`}
          />
        ))
      )}
    </Panel>
  );
}

/**
 * What the wishlist adds up to: the brands' list prices, one total per currency (never summed or
 * converted), with polishes that have no known price counted. Not what you paid.
 */
function WishlistPanel({ value }: { value: WishlistValueView | null }) {
  return (
    <Panel
      title="Wishlist"
      description="Brand list prices, not what you paid"
      loading={!value}
      testID="panel-wishlist"
    >
      {value && !value.summary ? (
        <PanelEmpty message="Your wishlist is empty. Tap ♡ on a shade in the catalog to save it." />
      ) : value ? (
        <>
          <AppText variant="small" testID="insights-wishlist-line">
            {value.line}
          </AppText>
          {value.hasPrices && value.asOf ? (
            <AppText variant="tiny" muted>
              Prices {value.asOf}. Currencies are not added together.
            </AppText>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

/** A stats shade: swatch, name and brand, a detail line and a value; taps open the polish. */
function ShadeRow({
  shade,
  detail,
  value,
  rank,
}: {
  shade: CollectionStatsShade;
  detail: string;
  value: string;
  rank?: number;
}) {
  const theme = useTheme();
  const { shadeId } = shade;
  return (
    <Pressable
      accessibilityRole={shadeId ? "button" : undefined}
      accessibilityLabel={`${shade.brand} ${shade.name}, ${value}, ${detail}`}
      disabled={!shadeId}
      onPress={shadeId ? () => router.push({ pathname: "/polishes/[id]", params: { id: shadeId } }) : undefined}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: theme.spacing(2.5), opacity: pressed ? 0.7 : 1 })}
    >
      {rank !== undefined ? (
        <AppText variant="small" muted style={{ width: 20, textAlign: "right" }}>
          {rank}
        </AppText>
      ) : null}
      <Swatch hex={statsDisplayHex(shade)} size={36} />
      <View style={{ flex: 1, gap: 1 }}>
        <AppText variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
          {shade.name}
        </AppText>
        <AppText variant="tiny" muted numberOfLines={1}>
          {shade.brand} · {detail}
        </AppText>
      </View>
      <AppText variant="small" style={{ fontWeight: "700" }}>
        {value}
      </AppText>
    </Pressable>
  );
}
