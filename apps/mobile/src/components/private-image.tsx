import { Image } from "expo-image";
import { ActivityIndicator, View, type ViewStyle } from "react-native";
import { usePrivateImage } from "@/lib/private-image-loader";
import { useTheme } from "@/theme/theme";
import { AppText } from "./ui";

/**
 * Owner-scoped private photo (web: `PrivateImage`). Fetched with the bearer token and shown from
 * an in-memory data URI; `cachePolicy="none"` keeps expo-image from writing it to its disk cache.
 */
export function PrivateImage({
  url,
  style,
  accessibilityLabel,
  compact = false,
}: {
  url: string | null | undefined;
  /** Box size only, shared by the image and its placeholder. */
  style: Pick<ViewStyle, "width" | "height" | "aspectRatio">;
  accessibilityLabel: string;
  /** Thumbnails: no text on failure, just a muted tile. */
  compact?: boolean;
}) {
  const theme = useTheme();
  const image = usePrivateImage(url);
  if (image.status === "ready") {
    return (
      <Image
        source={{ uri: image.uri }}
        cachePolicy="none"
        contentFit="cover"
        accessibilityLabel={accessibilityLabel}
        style={[{ borderRadius: theme.radius.lg, backgroundColor: theme.colors.muted }, style]}
      />
    );
  }
  const failed = image.status === "denied" || image.status === "error" || image.status === "offline";
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        { borderRadius: theme.radius.lg, backgroundColor: theme.colors.muted, alignItems: "center", justifyContent: "center", padding: theme.spacing(2) },
        style,
      ]}
    >
      {failed ? (
        compact ? null : (
          <AppText variant="tiny" muted style={{ textAlign: "center" }}>
            {image.status === "offline" ? "Photo unavailable offline" : "Couldn't load the photo"}
          </AppText>
        )
      ) : (
        <ActivityIndicator color={theme.colors.primary} />
      )}
    </View>
  );
}
