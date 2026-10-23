import { Image } from "expo-image";
import { PixelRatio, StyleSheet, Text, View } from "react-native";
import { resolveDisplayHex, type Polish } from "swatchwatch-shared";
import { swatchThumbnailUrl } from "@/lib/image-url";
import { useTheme } from "@/theme/theme";

/**
 * A polish swatch: the catalog thumbnail when there is one, over a fill of the display hex
 * (vendor > detected > name), so the color shows while the image loads or when it fails.
 */
export function Swatch({
  polish,
  hex,
  imageUrl,
  size = 48,
  rounded = "md",
}: {
  polish?: Pick<Polish, "vendorHex" | "detectedHex" | "nameHex" | "swatchImageUrl"> & Partial<Pick<Polish, "productCategory">>;
  hex?: string | null;
  imageUrl?: string | null;
  size?: number;
  rounded?: "md" | "full";
}) {
  const theme = useTheme();
  const fill = hex ?? (polish ? resolveDisplayHex(polish) : undefined);
  const source = imageUrl ?? polish?.swatchImageUrl;
  const radius = rounded === "full" ? size / 2 : theme.radius.lg;
  // A topper has no single color (D-D): neutral sparkle tile, never a color guess (web: TopperSwatch).
  if (polish?.productCategory === "topper") {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        testID="topper-swatch"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.muted,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
        }}
      >
        <Text style={{ fontSize: size * 0.45, color: theme.colors.mutedForeground }}>✦</Text>
      </View>
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: "hidden",
        backgroundColor: fill ?? theme.colors.muted,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
      }}
    >
      {source ? (
        <Image
          source={{ uri: swatchThumbnailUrl(source, PixelRatio.getPixelSizeForLayoutSize(size)) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          recyclingKey={source}
        />
      ) : null}
    </View>
  );
}

/** Small round color dot (web: `ColorDot`). */
export function ColorDot({ hex, size = 14 }: { hex?: string | null; size?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hex ?? theme.colors.muted,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
      }}
    />
  );
}
