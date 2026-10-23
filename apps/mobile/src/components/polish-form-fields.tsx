import Ionicons from "@expo/vector-icons/Ionicons";
import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
import { COLOR_FAMILY_LABELS, classifyColorFamily, type FinishName } from "swatchwatch-shared";
import { DEFAULT_LIGHTNESS_INDEX, HUE_STOPS, LIGHTNESS_STEPS, normalizeHexParam, pickerHex } from "@/lib/color-search";
import { toggleFinish, type FinishOption } from "@/lib/manual-add";
import { useTheme } from "@/theme/theme";
import { ColorDot } from "./swatch";
import { AppText, Button, Chip } from "./ui";

/** Shared by the manual add form and the detail screen's Edit details sheet. */

export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(2) }}>
      <AppText variant="label" muted>
        {label}
        {required ? " *" : ""}
      </AppText>
      {children}
      {error ? (
        <AppText variant="small" style={{ color: theme.colors.destructive }} accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="tiny" muted>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

export function FormInput({ invalid, style, ...props }: TextInputProps & { invalid?: boolean }) {
  const theme = useTheme();
  return (
    <TextInput
      accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
      placeholderTextColor={theme.colors.mutedForeground}
      autoCorrect={false}
      {...props}
      style={[
        {
          borderWidth: 1,
          borderColor: invalid ? theme.colors.destructive : theme.colors.input,
          borderRadius: theme.radius.lg,
          paddingHorizontal: theme.spacing(3),
          paddingVertical: theme.spacing(2.5),
          color: theme.colors.foreground,
          backgroundColor: theme.colors.card,
          fontSize: theme.font.body,
        },
        style,
      ]}
    />
  );
}

/** Five tappable stars; `onChange` gets the tapped star (the caller decides what re-tapping does). */
export function StarRating({ value, onChange, emptyHint = "Tap a star to rate" }: { value: number; onChange: (star: number) => void; emptyHint?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(1) }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable
          key={star}
          accessibilityRole="button"
          accessibilityLabel={`${star} ${star === 1 ? "star" : "stars"}`}
          accessibilityState={{ selected: star <= value }}
          hitSlop={4}
          onPress={() => onChange(star)}
        >
          <Ionicons
            name={star <= value ? "star" : "star-outline"}
            size={30}
            color={star <= value ? theme.colors.brand.pink : theme.colors.mutedForeground}
          />
        </Pressable>
      ))}
      <AppText variant="small" muted style={{ marginLeft: theme.spacing(2) }}>
        {value ? `${value} / 5` : emptyHint}
      </AppText>
    </View>
  );
}

/** − / + bottle count, bounded to `min`…`max`. */
export function QuantityStepper({
  value,
  max,
  onChange,
  min = 1,
}: {
  value: number;
  max: number;
  onChange: (next: number) => void;
  min?: number;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
      <Button title="−" variant="outline" compact accessibilityLabel="One bottle fewer" disabled={value <= min} onPress={() => onChange(value - 1)} />
      <AppText variant="heading" accessibilityLiveRegion="polite" style={{ minWidth: 32, textAlign: "center" }}>
        {value}
      </AppText>
      <Button title="+" variant="outline" compact accessibilityLabel="One more bottle" disabled={value >= max} onPress={() => onChange(value + 1)} />
    </View>
  );
}

/** Finish chips; tap in order, the first selected is the main finish. */
export function FinishField({
  finishOptions,
  selected,
  onChange,
}: {
  finishOptions: readonly FinishOption[];
  selected: readonly FinishName[];
  onChange: (next: FinishName[]) => void;
}) {
  const theme = useTheme();
  return (
    <Field label="Finish" hint="Tap in order: the first is the main finish.">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
        {finishOptions.map((option) => {
          const index = selected.indexOf(option.value);
          return (
            <Chip
              key={option.value}
              label={index === 0 && selected.length > 1 ? `${option.label} · main` : option.label}
              selected={index >= 0}
              onPress={() => onChange(toggleFinish(selected, option.value))}
            />
          );
        })}
      </View>
    </Field>
  );
}

/** A hue stop index into `HUE_STOPS`, or `"neutral"`. */
type HueChoice = number | "neutral";

/** Hue / lightness picker plus a hex box and an optional color name (manual add and Edit details). */
export function ColorField({
  hex: hexText,
  colorName,
  finishes,
  error,
  onHexChange,
  onColorNameChange,
  hint = "Pick the closest color, or type a hex.",
  allowClear = true,
}: {
  hex: string;
  colorName: string;
  finishes: readonly FinishName[];
  error?: string;
  onHexChange: (hex: string) => void;
  onColorNameChange: (name: string) => void;
  hint?: string;
  allowClear?: boolean;
}) {
  const theme = useTheme();
  const [hue, setHue] = useState<HueChoice | null>(null);
  const [lightness, setLightness] = useState(DEFAULT_LIGHTNESS_INDEX);
  const hex = normalizeHexParam(hexText);
  const family = hex ? classifyColorFamily({ vendorHex: hex, finishes: [...finishes] }) : null;

  function pickColor(nextHue: HueChoice, nextLightness: number) {
    setHue(nextHue);
    setLightness(nextLightness);
    onHexChange(pickerHex(nextHue === "neutral" ? null : HUE_STOPS[nextHue], nextLightness));
  }

  return (
    <Field label="Color" error={error} hint={hint}>
      <View style={{ gap: theme.spacing(3) }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
          {[...HUE_STOPS.map((_, i) => i as HueChoice), "neutral" as const].map((choice) => {
            const chipHex = pickerHex(choice === "neutral" ? null : HUE_STOPS[choice], lightness);
            const chipFamily = classifyColorFamily({ vendorHex: chipHex });
            const selected = hue === choice && hex === chipHex.toUpperCase();
            return (
              <ColorButton
                key={String(choice)}
                hex={chipHex}
                selected={selected}
                label={choice === "neutral" ? "Neutral" : chipFamily ? COLOR_FAMILY_LABELS[chipFamily] : `Hue ${HUE_STOPS[choice]}`}
                onPress={() => pickColor(choice, lightness)}
              />
            );
          })}
        </View>
        {hue !== null && (
          <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
            {LIGHTNESS_STEPS.map((_, i) => {
              const stepHex = pickerHex(hue === "neutral" ? null : HUE_STOPS[hue], i);
              return (
                <ColorButton
                  key={i}
                  hex={stepHex}
                  wide
                  selected={lightness === i && hex === stepHex.toUpperCase()}
                  label={`Lightness ${i + 1} of ${LIGHTNESS_STEPS.length}`}
                  onPress={() => pickColor(hue, i)}
                />
              );
            })}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
          <ColorDot hex={hex} size={28} />
          <View style={{ flex: 1 }}>
            <FormInput
              value={hexText}
              onChangeText={(v) => {
                setHue(null);
                onHexChange(v);
              }}
              placeholder="#C0392B"
              autoCapitalize="characters"
              maxLength={7}
              accessibilityLabel="Color hex"
              invalid={Boolean(error)}
            />
          </View>
          {allowClear && hexText ? (
            <Button
              title="Clear"
              variant="ghost"
              compact
              onPress={() => {
                setHue(null);
                onHexChange("");
              }}
            />
          ) : null}
        </View>
        <FormInput
          value={colorName}
          onChangeText={onColorNameChange}
          placeholder={family ? `Color name (default: ${COLOR_FAMILY_LABELS[family]})` : "Color name, e.g. Teal (optional)"}
          accessibilityLabel="Color name"
          autoCapitalize="words"
        />
      </View>
    </Field>
  );
}

function ColorButton({
  hex,
  label,
  selected,
  wide,
  onPress,
}: {
  hex: string;
  label: string;
  selected: boolean;
  wide?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        width: wide ? undefined : 36,
        flex: wide ? 1 : undefined,
        height: 36,
        borderRadius: wide ? theme.radius.md : 18,
        backgroundColor: hex,
        borderWidth: selected ? 3 : 1,
        borderColor: selected ? theme.colors.foreground : theme.colors.border,
      }}
    />
  );
}
