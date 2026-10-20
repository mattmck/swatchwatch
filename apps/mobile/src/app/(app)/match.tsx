import { Image } from "expo-image";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { ColorMatchGroup, MatchScope, Polish, PolishImageMatchResponse, PolishMatch, PolishStatus } from "swatchwatch-shared";
import { errorMessage, matchPolishesToImage, updatePolish } from "@/api/client";
import { ColorDot, Swatch } from "@/components/swatch";
import { AppText, Button, Card, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { confirmAddWithDupes } from "@/lib/add-guard";
import {
  activeColorGroups,
  activePaletteColors,
  CONFIDENCE_LABELS,
  DEFAULT_PALETTE_SELECTION,
  formatFraction,
  hiddenByDefaultCount,
  MATCH_SCOPE_OPTIONS,
  matchPercent,
  normalizePaletteHex,
  PALETTE_KIND_LABELS,
  paletteChipState,
  paletteColorKind,
  replaceMatchedPolish,
  togglePaletteColor,
  type PaletteSelection,
} from "@/lib/photo-match";
import { pickPreparedPhoto, type PhotoSource } from "@/lib/pick-photo";
import { isOwnedPolish, POLISH_STATUS_LABELS, statusChangePatch } from "@/lib/status";
import { useTheme } from "@/theme/theme";

/** Same request shape as the web page (#373): up to 8 colors, 8 matches per color. */
const MATCH_REQUEST = { maxColors: 8, perColorLimit: 8, limit: 20 } as const;

/**
 * Match to Collection (#105, web: `/polishes/match`): pick or take a photo, send a small JPEG to
 * `POST /api/polishes/match-image` (server-side palette extraction; the image is never stored),
 * then show the matches grouped by photo color. Palette chips choose which colors take part
 * (client-side, no re-upload); not-owned matches get Add / ♡ Wishlist behind the add guard.
 */
export default function MatchScreen() {
  const theme = useTheme();
  const [preview, setPreview] = useState<string | null>(null);
  const [scope, setScope] = useState<MatchScope>("owned");
  const [result, setResult] = useState<PolishImageMatchResponse | null>(null);
  const [selection, setSelection] = useState<PaletteSelection>(DEFAULT_PALETTE_SELECTION);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const generation = useRef(0);

  async function runMatch(dataUrl: string, nextScope: MatchScope) {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelection(DEFAULT_PALETTE_SELECTION);
    try {
      const res = await matchPolishesToImage(dataUrl, { ...MATCH_REQUEST, scope: nextScope });
      if (gen === generation.current) setResult(res);
    } catch (err) {
      if (gen === generation.current) setError(errorMessage(err, "Couldn't match that photo."));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }

  async function choose(from: PhotoSource) {
    setError(null);
    try {
      // Palette extraction needs few pixels; 512px keeps the upload small on cellular.
      const prepared = await pickPreparedPhoto(from, { maxEdge: 512, compress: 0.8 });
      if (!prepared) return;
      setPreview(prepared.dataUrl);
      await runMatch(prepared.dataUrl, scope);
    } catch (err) {
      setError(errorMessage(err, "Couldn't use that photo."));
    }
  }

  function changeScope(next: MatchScope) {
    if (next === scope) return;
    setScope(next);
    if (preview) void runMatch(preview, next);
  }

  function reset() {
    generation.current += 1;
    setPreview(null);
    setResult(null);
    setSelection(DEFAULT_PALETTE_SELECTION);
    setError(null);
    setLoading(false);
  }

  async function setStatus(polish: Polish, status: PolishStatus) {
    const choice = await confirmAddWithDupes(polish.id, status === "owned" ? "owned" : "wishlist");
    if (choice === "cancel") return;
    const target: PolishStatus = choice === "wishlist" ? "wishlist" : status;
    setPending((p) => ({ ...p, [polish.id]: true }));
    try {
      const updated = await updatePolish(polish.id, statusChangePatch(polish, target));
      setResult((r) => (r ? { ...r, colorMatches: replaceMatchedPolish(r.colorMatches ?? [], updated) } : r));
    } catch (err) {
      setError(errorMessage(err, "Couldn't update that polish."));
    } finally {
      setPending((p) => ({ ...p, [polish.id]: false }));
    }
  }

  const palette = useMemo(() => result?.extractedColors ?? [], [result]);
  const active = useMemo(() => activePaletteColors(palette, selection), [palette, selection]);
  const groups = useMemo(() => (result ? activeColorGroups(result, active) : []), [result, active]);
  const hiddenCount = hiddenByDefaultCount(palette, selection);
  const fractionByHex = new Map(palette.map((c) => [normalizePaletteHex(c.hex), c.fraction]));
  const anyMatches = groups.some((g) => g.matches.length > 0);

  return (
    <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
      <AppText muted>Photograph an outfit, a look or a swatch, and find polishes that match its colors.</AppText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }} accessibilityRole="radiogroup">
        {MATCH_SCOPE_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={scope === option.value}
            onPress={() => changeScope(option.value)}
          />
        ))}
      </View>
      {preview ? (
        <Button title="Match another photo" variant="outline" onPress={reset} disabled={loading} testID="match-another" />
      ) : (
        <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
          <Button title="Take a photo" variant="brand" onPress={() => void choose("camera")} style={{ flex: 1 }} disabled={loading} />
          <Button title="Choose photo" variant="outline" onPress={() => void choose("library")} style={{ flex: 1 }} disabled={loading} />
        </View>
      )}
      {error && <ErrorBanner message={error} onRetry={preview ? () => void runMatch(preview, scope) : undefined} />}

      {preview && (
        <Image source={{ uri: preview }} cachePolicy="none" style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: theme.radius.xl }} contentFit="cover" />
      )}

      {loading && <CenteredState loading message="Finding your matches…" />}

      {result && (
        <>
          <Card>
            <AppText variant="label" muted>
              Colors in the photo
            </AppText>
            <AppText variant="tiny" muted>
              Tap a color to leave it out of matching or bring it back.
            </AppText>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
              {palette.map((color) => {
                const state = paletteChipState(color, palette, selection);
                if (state === "hidden" && !selection.showAll) return null;
                const kind = paletteColorKind(color);
                return (
                  <Pressable
                    key={color.hex}
                    accessibilityRole="button"
                    accessibilityLabel={`${state === "active" ? "Leave out" : "Use"} ${color.hex}${kind !== "color" ? ` (${PALETTE_KIND_LABELS[kind]})` : ""}`}
                    accessibilityState={{ selected: state === "active" }}
                    onPress={() => setSelection((s) => togglePaletteColor(color.hex, palette, s))}
                    style={{
                      alignItems: "center",
                      gap: 4,
                      padding: 4,
                      borderRadius: theme.radius.md,
                      borderWidth: 2,
                      borderColor: state === "active" ? theme.colors.primary : "transparent",
                      opacity: state === "active" ? 1 : 0.4,
                    }}
                  >
                    <ColorDot hex={color.hex} size={36} />
                    <AppText variant="tiny" muted>
                      {kind === "color" ? formatFraction(color.fraction) : PALETTE_KIND_LABELS[kind]}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
            {(hiddenCount > 0 || selection.showAll) && (
              <Button
                title={selection.showAll ? "Hide background colors" : `Show all colors (${hiddenCount} hidden)`}
                variant="ghost"
                compact
                onPress={() => setSelection((s) => ({ ...s, showAll: !s.showAll, keep: [] }))}
              />
            )}
            <AppText variant="tiny" muted>
              Compared against {result.candidateCount} {MATCH_SCOPE_OPTIONS.find((o) => o.value === scope)?.label.toLowerCase()} polishes.
            </AppText>
          </Card>

          {result.candidateCount === 0 ? (
            <CenteredState
              title="Nothing to compare"
              message={scope === "owned" ? "Add polishes with a known color to your collection first." : "No polishes with a known color here yet."}
            />
          ) : active.length === 0 ? (
            <CenteredState title="No colors selected" message="Tap a color above to match it." />
          ) : !anyMatches ? (
            <CenteredState title="No close matches" message="Nothing here is near these colors." />
          ) : (
            groups.map((group) => (
              <ColorGroup
                key={group.hex}
                group={group}
                fraction={fractionByHex.get(normalizePaletteHex(group.hex)) ?? 0}
                pending={pending}
                onSetStatus={(polish, status) => void setStatus(polish, status)}
              />
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

function ColorGroup({
  group,
  fraction,
  pending,
  onSetStatus,
}: {
  group: ColorMatchGroup;
  fraction: number;
  pending: Record<string, boolean>;
  onSetStatus: (polish: Polish, status: PolishStatus) => void;
}) {
  const theme = useTheme();
  return (
    <Card testID="match-color-group">
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
        <ColorDot hex={group.hex} size={24} />
        <AppText style={{ fontWeight: "600", flex: 1 }}>
          {group.hex.toUpperCase()} · {formatFraction(fraction)} of the photo
        </AppText>
      </View>
      {group.matches.length === 0 ? (
        <AppText variant="small" muted>
          No match for this color.
        </AppText>
      ) : (
        group.matches.map((match) => (
          <MatchRow key={match.polish.id} match={match} busy={Boolean(pending[match.polish.id])} onSetStatus={onSetStatus} />
        ))
      )}
    </Card>
  );
}

function MatchRow({
  match,
  busy,
  onSetStatus,
}: {
  match: PolishMatch;
  busy: boolean;
  onSetStatus: (polish: Polish, status: PolishStatus) => void;
}) {
  const theme = useTheme();
  const { polish } = match;
  const owned = isOwnedPolish(polish);
  return (
    <View style={{ gap: theme.spacing(1.5) }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: polish.id } })}
        style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}
      >
        <Swatch polish={polish} size={48} />
        <View style={{ flex: 1 }}>
          <AppText variant="tiny" muted numberOfLines={1}>
            {polish.brand}
          </AppText>
          <AppText style={{ fontWeight: "600" }} numberOfLines={1}>
            {polish.name}
          </AppText>
          <AppText variant="tiny" muted>
            {matchPercent(match.distance)}% match{polish.status ? ` · ${POLISH_STATUS_LABELS[polish.status]}` : ""}
          </AppText>
        </View>
        <Chip label={CONFIDENCE_LABELS[match.confidence]} tone={match.confidence === "high" ? "success" : match.confidence === "medium" ? "warning" : "default"} />
      </Pressable>
      {!owned && (
        <View style={{ flexDirection: "row", gap: theme.spacing(2), justifyContent: "flex-end" }}>
          {polish.status !== "wishlist" && (
            <Button
              title="♡ Wishlist"
              variant="outline"
              compact
              disabled={busy}
              accessibilityLabel={`Wishlist ${polish.brand} ${polish.name}`}
              onPress={() => onSetStatus(polish, "wishlist")}
            />
          )}
          <Button
            title={polish.status === "wishlist" ? "I bought it" : "Add"}
            variant="primary"
            compact
            loading={busy}
            disabled={busy}
            accessibilityLabel={`Add ${polish.brand} ${polish.name} to your collection`}
            onPress={() => onSetStatus(polish, "owned")}
          />
        </View>
      )}
    </View>
  );
}
