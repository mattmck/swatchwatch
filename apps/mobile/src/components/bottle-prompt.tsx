import { useState } from "react";
import { TextInput, View } from "react-native";
import { batchHeaderLabel, isBatchMode, type BottleCameraView, type CaptureFrameType, type StickyHints } from "swatchwatch-shared";
import { useTheme } from "@/theme/theme";
import { AppText, Button, Card, Chip } from "./ui";

const FRAME_TYPES: { type: CaptureFrameType; label: string }[] = [
  { type: "barcode", label: "Barcode" },
  { type: "label", label: "Label" },
  { type: "color", label: "Color" },
];

/** What the bottle sequence asks for next, with a way to skip it and the manual photo types. */
export function BottlePrompt({
  view,
  manualType,
  disabled,
  onManualType,
  onSkip,
}: {
  /** The next photo to take; `null` = nothing is being asked (any photo still goes to the scan). */
  view: BottleCameraView | null;
  /** A photo type picked under "More options" instead of following the prompt. */
  manualType: CaptureFrameType | null;
  disabled: boolean;
  onManualType: (type: CaptureFrameType | null) => void;
  onSkip: () => void;
}) {
  const theme = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <Card testID="bottle-prompt" style={{ paddingVertical: theme.spacing(3) }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: theme.spacing(3) }}>
        <View style={{ flex: 1, gap: 2 }}>
          {view && (
            <AppText variant="label" muted>
              Step {view.step} of {view.total}
            </AppText>
          )}
          <AppText variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite">
            {view?.prompt ?? "Take a photo of the bottle"}
          </AppText>
          {Boolean(view?.hint) && (
            <AppText variant="small" muted>
              {view?.hint}
            </AppText>
          )}
        </View>
        {view && <Button title="Can't see it" variant="outline" compact disabled={disabled} onPress={onSkip} />}
      </View>
      <AppText
        variant="small"
        accessibilityRole="button"
        style={{ fontWeight: "600" }}
        onPress={() => setMoreOpen((open) => !open)}
      >
        {moreOpen ? "▾" : "▸"} More options
      </AppText>
      {moreOpen && (
        <View style={{ gap: theme.spacing(2) }}>
          <AppText variant="tiny" muted>
            Take a different kind of photo instead (used for the next photo only).
          </AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
            {FRAME_TYPES.map((t) => (
              <Chip
                key={t.type}
                label={t.label}
                selected={manualType === t.type}
                onPress={() => onManualType(manualType === t.type ? null : t.type)}
              />
            ))}
          </View>
        </View>
      )}
    </Card>
  );
}

/**
 * "Going through one brand": a brand field while off, "Going through: X · Done" while on. The
 * brand is sent with every scan's start and remembered across scans and launches.
 */
export function BatchBrandBar({
  hints,
  onSetBrand,
  onDone,
}: {
  hints: StickyHints;
  onSetBrand: (brand: string) => void;
  onDone: () => void;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const header = batchHeaderLabel(hints);
  if (isBatchMode(hints) && header) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
        <AppText style={{ flex: 1, fontWeight: "600" }} numberOfLines={1} testID="batch-header">
          {header}
        </AppText>
        <Button title="Done" variant="outline" compact onPress={onDone} />
      </View>
    );
  }
  function commit() {
    const brand = draft.trim();
    if (!brand) return;
    setDraft("");
    onSetBrand(brand);
  }
  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onEndEditing={commit}
      placeholder="Going through one brand? Type it (optional)"
      accessibilityLabel="Brand for this batch"
      placeholderTextColor={theme.colors.mutedForeground}
      autoCorrect={false}
      returnKeyType="done"
      style={{
        borderWidth: 1,
        borderColor: theme.colors.input,
        borderRadius: theme.radius.lg,
        paddingHorizontal: theme.spacing(3),
        paddingVertical: theme.spacing(2),
        color: theme.colors.foreground,
      }}
    />
  );
}
