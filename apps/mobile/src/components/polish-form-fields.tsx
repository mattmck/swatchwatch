import Ionicons from "@expo/vector-icons/Ionicons";
import type { ReactNode } from "react";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "@/theme/theme";
import { AppText, Button } from "./ui";

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
