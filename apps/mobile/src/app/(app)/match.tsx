import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { MatchConfidence, PolishImageMatchResponse } from "swatchwatch-shared";
import { errorMessage, matchPolishesToImage } from "@/api/client";
import { ColorDot, Swatch } from "@/components/swatch";
import { AppText, Button, Card, CenteredState, Chip, ErrorBanner } from "@/components/ui";
import { prepareJpeg } from "@/lib/image-prep";
import { useTheme } from "@/theme/theme";

const CONFIDENCE_LABELS: Record<MatchConfidence, string> = { high: "Close match", medium: "Similar", low: "Loose" };

/**
 * Match to Collection (#105, web: `/polishes/match`): pick or take a photo, send a small JPEG
 * to `POST /api/polishes/match-image` (server-side palette extraction; the image is never
 * stored), and list the owned polishes closest to its dominant colors. On-device extraction
 * (native modules) is a follow-up.
 */
export default function MatchScreen() {
  const theme = useTheme();
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<PolishImageMatchResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(from: "camera" | "library") {
    setError(null);
    try {
      if (from === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError("Camera access is off. Allow it in Settings, or choose a photo instead.");
          return;
        }
      }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1 };
      const picked = from === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      const asset = picked.canceled ? null : picked.assets[0];
      if (!asset) return;
      setLoading(true);
      setResult(null);
      setSelected(null);
      // Palette extraction needs few pixels; 512px keeps the upload small on cellular.
      const prepared = await prepareJpeg(asset.uri, asset, { maxEdge: 512, compress: 0.8 });
      setPreview(prepared.dataUrl);
      setResult(await matchPolishesToImage(prepared.dataUrl, { maxColors: 6, limit: 30 }));
    } catch (err) {
      setError(errorMessage(err, "Couldn't match that photo."));
    } finally {
      setLoading(false);
    }
  }

  const matches = result?.matches.filter((m) => !selected || m.matchedColor === selected) ?? [];

  return (
    <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
      <AppText muted>Photograph an outfit, a look or a swatch, and find the polishes you own that match it.</AppText>
      <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
        <Button title="Take a photo" variant="brand" onPress={() => void choose("camera")} style={{ flex: 1 }} disabled={loading} />
        <Button title="Choose photo" variant="outline" onPress={() => void choose("library")} style={{ flex: 1 }} disabled={loading} />
      </View>
      {error && <ErrorBanner message={error} />}

      {preview && (
        <Image source={{ uri: preview }} style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: theme.radius.xl }} contentFit="cover" />
      )}

      {loading && <CenteredState loading message="Finding your matches…" />}

      {result && (
        <>
          <Card>
            <AppText variant="label" muted>
              Colors in the photo
            </AppText>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
              {result.extractedColors.map((color) => (
                <Pressable
                  key={color.hex}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter matches to ${color.hex}`}
                  accessibilityState={{ selected: selected === color.hex }}
                  onPress={() => setSelected((s) => (s === color.hex ? null : color.hex))}
                  style={{
                    alignItems: "center",
                    gap: 4,
                    padding: 4,
                    borderRadius: theme.radius.md,
                    borderWidth: 2,
                    borderColor: selected === color.hex ? theme.colors.primary : "transparent",
                  }}
                >
                  <ColorDot hex={color.hex} size={36} />
                  <AppText variant="tiny" muted>
                    {Math.round(color.fraction * 100)}%
                  </AppText>
                </Pressable>
              ))}
            </View>
            <AppText variant="tiny" muted>
              Compared against {result.candidateCount} owned polishes{selected ? ` · showing ${selected}` : ""}.
            </AppText>
          </Card>

          {matches.length === 0 ? (
            <CenteredState title="No close matches" message="Nothing you own is near these colors." />
          ) : (
            <View style={{ gap: theme.spacing(2) }}>
              {matches.map((match) => (
                <Pressable
                  key={`${match.polish.id}:${match.matchedColor}`}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: match.polish.id } })}
                  style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}
                >
                  <Swatch polish={match.polish} size={48} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="tiny" muted numberOfLines={1}>
                      {match.polish.brand}
                    </AppText>
                    <AppText style={{ fontWeight: "600" }} numberOfLines={1}>
                      {match.polish.name}
                    </AppText>
                  </View>
                  <ColorDot hex={match.matchedColor} size={18} />
                  <Chip label={CONFIDENCE_LABELS[match.confidence]} tone={match.confidence === "high" ? "success" : "default"} />
                </Pressable>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
