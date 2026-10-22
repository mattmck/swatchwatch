import { Image } from "expo-image";
import { ActivityIndicator, ScrollView, View } from "react-native";
import type { CaptureFrameEntry } from "@/lib/rapid-add";
import { useTheme } from "@/theme/theme";
import { AppText, Button } from "./ui";

const FRAME_TYPE_LABELS = { barcode: "Barcode", label: "Label", color: "Color", other: "Other" } as const;

/** Thumbnails of the frames in this scan with their upload state; failed ones get Retry / Remove. */
export function FrameStrip({
  frames,
  onRetry,
  onRemove,
}: {
  frames: readonly CaptureFrameEntry[];
  onRetry: (localId: string) => void;
  onRemove: (localId: string) => void;
}) {
  const theme = useTheme();
  if (frames.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing(2) }}>
      {frames.map((frame) => (
        <View key={frame.localId} style={{ width: 96, gap: 4 }} accessibilityLabel={`${FRAME_TYPE_LABELS[frame.frameType]} frame, ${frame.status}`}>
          <View
            style={{
              width: 96,
              height: 96,
              borderRadius: theme.radius.lg,
              overflow: "hidden",
              borderWidth: 2,
              borderColor:
                frame.status === "failed" ? theme.colors.destructive : frame.status === "uploaded" ? theme.colors.success : theme.colors.border,
            }}
          >
            <Image source={{ uri: frame.dataUrl }} style={{ flex: 1 }} contentFit="cover" />
            {frame.status === "uploading" && (
              <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#0006" }}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
          </View>
          <AppText variant="tiny" muted numberOfLines={1}>
            {FRAME_TYPE_LABELS[frame.frameType]} · {frame.status === "uploaded" ? "sent" : frame.status === "failed" ? "failed" : "sending"}
          </AppText>
          {frame.status === "failed" && (
            <View style={{ flexDirection: "row", gap: 4 }}>
              <Button title="Retry" compact variant="outline" onPress={() => onRetry(frame.localId)} />
              <Button title="✕" compact variant="ghost" accessibilityLabel="Remove frame" onPress={() => onRemove(frame.localId)} />
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
