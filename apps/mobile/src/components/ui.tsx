import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useTheme } from "@/theme/theme";

type TextVariant = "title" | "heading" | "body" | "small" | "tiny" | "label";

export function AppText({
  variant = "body",
  muted,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; muted?: boolean }) {
  const theme = useTheme();
  const base: TextStyle = {
    color: muted ? theme.colors.mutedForeground : theme.colors.foreground,
    fontSize:
      variant === "title"
        ? theme.font.title
        : variant === "heading"
          ? theme.font.heading
          : variant === "small"
            ? theme.font.small
            : variant === "tiny" || variant === "label"
              ? theme.font.tiny
              : theme.font.body,
    fontWeight: variant === "title" || variant === "heading" ? "700" : variant === "label" ? "600" : "400",
    letterSpacing: variant === "label" ? 0.6 : undefined,
    textTransform: variant === "label" ? "uppercase" : undefined,
  };
  return <Text {...rest} style={[base, style]} />;
}

type ButtonVariant = "primary" | "brand" | "outline" | "ghost" | "destructive";

export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon,
  style,
  compact,
  accessibilityLabel,
  testID,
}: {
  title: string;
  onPress?: PressableProps["onPress"];
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: colors.primary },
    brand: { bg: colors.brand.pink, fg: "#ffffff", border: colors.brand.pink },
    outline: { bg: "transparent", fg: colors.foreground, border: colors.border },
    ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
    destructive: { bg: colors.destructive, fg: "#ffffff", border: colors.destructive },
  };
  const tone = palette[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: tone.bg,
          borderColor: tone.border,
          borderRadius: theme.radius.lg,
          paddingVertical: compact ? 8 : 12,
          paddingHorizontal: compact ? 12 : 16,
          opacity: inactive ? 0.5 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={tone.fg} /> : icon}
      <Text style={{ color: tone.fg, fontWeight: "600", fontSize: compact ? theme.font.small : theme.font.body }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: theme.radius.xl,
          padding: theme.spacing(4),
          gap: theme.spacing(3),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  tone,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  tone?: "default" | "brand" | "success" | "warning";
}) {
  const theme = useTheme();
  const { colors } = theme;
  const toneColor =
    tone === "success" ? colors.success : tone === "warning" ? colors.warning : tone === "brand" ? colors.brand.pink : colors.primary;
  const content = (
    <Text
      style={{
        fontSize: theme.font.tiny,
        fontWeight: "600",
        color: selected ? colors.primaryForeground : tone && tone !== "default" ? toneColor : colors.secondaryForeground,
      }}
    >
      {label}
    </Text>
  );
  const style: ViewStyle = {
    paddingHorizontal: 10,
    paddingVertical: onPress ? 7 : 3,
    borderRadius: theme.radius.pill,
    backgroundColor: selected ? colors.primary : colors.secondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: selected ? colors.primary : tone && tone !== "default" ? toneColor : colors.border,
    alignSelf: "flex-start",
  };
  if (!onPress) return <View style={style}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [style, { opacity: pressed ? 0.7 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

export function CenteredState({
  title,
  message,
  action,
  loading,
}: {
  title?: string;
  message?: string;
  action?: ReactNode;
  loading?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.centered, { padding: theme.spacing(8), gap: theme.spacing(3) }]}>
      {loading && <ActivityIndicator color={theme.colors.primary} />}
      {title && (
        <AppText variant="heading" style={{ textAlign: "center" }}>
          {title}
        </AppText>
      )}
      {message && (
        <AppText muted style={{ textAlign: "center" }}>
          {message}
        </AppText>
      )}
      {action}
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing(2),
        padding: theme.spacing(3),
        borderRadius: theme.radius.lg,
        backgroundColor: theme.scheme === "dark" ? "#7f1d1d55" : "#fef2f2",
      }}
    >
      <AppText variant="small" style={{ flex: 1, color: theme.colors.destructive }}>
        {message}
      </AppText>
      {onRetry && <Button title="Retry" variant="outline" compact onPress={onRetry} />}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
