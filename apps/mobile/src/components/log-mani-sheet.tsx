import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  MAX_MANICURE_NOTES_LENGTH,
  MAX_MANICURE_POLISHES,
  NAIL_PHOTO_MAX_EDGE,
  type Manicure,
  type Polish,
} from "swatchwatch-shared";
import { createManicure, errorMessage, listPolishes, uploadManicurePhoto } from "@/api/client";
import { pickPreparedPhoto, type PhotoSource } from "@/lib/pick-photo";
import {
  addEntry,
  buildManiRequest,
  cycleRole,
  entryFromPolish,
  removeEntry,
  ROLE_LABELS,
  shiftDate,
  validateManiForm,
  type ManiEntry,
} from "@/lib/mani";
import { localIsoDate } from "@/lib/status";
import { useTheme } from "@/theme/theme";
import { ColorDot } from "./swatch";
import { AppText, Button, Chip, ErrorBanner } from "./ui";

/**
 * "Log a mani" sheet (web: `mani-log-form.tsx`): polishes with roles (tap a role to cycle),
 * the date worn, notes. Polishes come from the owned collection via a text filter, so a mani
 * can only reference polishes the caller owns, as on the web.
 */
export function LogManiSheet(props: {
  visible: boolean;
  initialPolish?: Polish | null;
  /** Entries to start with (Looks' "Wear this"); wins over `initialPolish`. */
  initialEntries?: readonly ManiEntry[];
  onClose: () => void;
  /** `photoError` is set when the mani was saved but its photo upload failed. */
  onLogged: (mani: Manicure, photoError?: string) => void;
}) {
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      {/* Mounted only while open, so every opening starts from a fresh form. */}
      {props.visible && <SheetBody initialPolish={props.initialPolish} initialEntries={props.initialEntries} onClose={props.onClose} onLogged={props.onLogged} />}
    </Modal>
  );
}

function SheetBody({
  initialPolish,
  initialEntries,
  onClose,
  onLogged,
}: {
  initialPolish?: Polish | null;
  initialEntries?: readonly ManiEntry[];
  onClose: () => void;
  onLogged: (mani: Manicure, photoError?: string) => void;
}) {
  const theme = useTheme();
  const [entries, setEntries] = useState<ManiEntry[]>(() =>
    initialEntries ? [...initialEntries] : initialPolish ? [entryFromPolish(initialPolish)] : [],
  );
  const [wornOn, setWornOn] = useState(localIsoDate());
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Polish[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Optional photo (#327): a prepared JPEG data URL, uploaded once the mani is saved. */
  const [photo, setPhoto] = useState<string | null>(null);
  const [preparingPhoto, setPreparingPhoto] = useState(false);

  // Owned-polish search while typing.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      listPolishes({ status: ["owned"], search: q, pageSize: 8, sortBy: "name", sortOrder: "asc" })
        .then((res) => !cancelled && setResults(res.polishes))
        .catch((err: unknown) => !cancelled && setError(errorMessage(err, "Search failed.")));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  async function save() {
    const message = validateManiForm({ entries, wornOn, notes });
    if (message) {
      setError(message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await createManicure(buildManiRequest({ entries, wornOn, notes }));
      if (!photo) {
        onLogged(saved);
        return;
      }
      // The photo route needs the manicure id, so it is uploaded after the mani is written
      // (same order as the web form). A failed upload keeps the mani and reports the photo.
      try {
        const uploaded = await uploadManicurePhoto(saved.id, photo);
        onLogged({ ...saved, photoImageId: uploaded.photoImageId, photoUrl: uploaded.photoUrl });
      } catch (err) {
        onLogged(saved, errorMessage(err, "The photo couldn't be uploaded."));
      }
    } catch (err) {
      setError(errorMessage(err, "Couldn't log the mani."));
    } finally {
      setSaving(false);
    }
  }

  async function choosePhoto(from: PhotoSource) {
    setError(null);
    setPreparingPhoto(true);
    try {
      const prepared = await pickPreparedPhoto(from, { maxEdge: NAIL_PHOTO_MAX_EDGE, compress: 0.85 });
      if (prepared) setPhoto(prepared.dataUrl);
    } catch (err) {
      setError(errorMessage(err, "Couldn't use that photo."));
    } finally {
      setPreparingPhoto(false);
    }
  }

  const shown = query.trim() ? results : [];
  return (
    <>
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing(4) }}>
          <AppText variant="heading" accessibilityRole="header">
            Log a mani
          </AppText>
          <Button title="Cancel" variant="ghost" compact onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing(4), paddingTop: 0, gap: theme.spacing(4) }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: theme.spacing(2) }}>
            <AppText variant="label" muted>
              Polishes ({entries.length}/{MAX_MANICURE_POLISHES})
            </AppText>
            {entries.length === 0 && (
              <AppText variant="small" muted>
                Search your collection below and tap a polish to add it. Tap a role to change it.
              </AppText>
            )}
            {entries.map((entry, index) => (
              <View key={`${entry.shadeId}:${entry.role}`} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
                <ColorDot hex={entry.hex} size={22} />
                <View style={{ flex: 1 }}>
                  <AppText variant="tiny" muted numberOfLines={1}>
                    {entry.brand}
                  </AppText>
                  <AppText numberOfLines={1} style={{ fontWeight: "600" }}>
                    {entry.name}
                  </AppText>
                </View>
                <Chip label={ROLE_LABELS[entry.role]} onPress={() => setEntries((e) => cycleRole(e, index))} />
                <Button title="✕" variant="ghost" compact accessibilityLabel={`Remove ${entry.name}`} onPress={() => setEntries((e) => removeEntry(e, index))} />
              </View>
            ))}
          </View>

          <View style={{ gap: theme.spacing(2) }}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Add a polish you own"
              placeholderTextColor={theme.colors.mutedForeground}
              autoCorrect={false}
              accessibilityLabel="Search your polishes to add"
              style={inputStyle(theme)}
            />
            {shown.map((polish) => (
              <Pressable
                key={polish.id}
                accessibilityRole="button"
                accessibilityLabel={`Add ${polish.brand} ${polish.name}`}
                onPress={() => {
                  setEntries((e) => addEntry(e, entryFromPolish(polish)));
                  setQuery("");
                  setResults([]);
                }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: theme.spacing(2),
                  padding: theme.spacing(2),
                  borderRadius: theme.radius.md,
                  backgroundColor: pressed ? theme.colors.muted : "transparent",
                })}
              >
                <ColorDot hex={entryFromPolish(polish).hex} size={20} />
                <AppText style={{ flex: 1 }} numberOfLines={1}>
                  {polish.brand} — {polish.name}
                </AppText>
              </Pressable>
            ))}
          </View>

          <View style={{ gap: theme.spacing(2) }}>
            <AppText variant="label" muted>
              Worn on
            </AppText>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <Button title="◀" variant="outline" compact accessibilityLabel="Previous day" onPress={() => setWornOn((d) => shiftDate(d, -1))} />
              <TextInput
                value={wornOn}
                onChangeText={setWornOn}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.colors.mutedForeground}
                autoCorrect={false}
                accessibilityLabel="Date worn"
                style={[inputStyle(theme), { flex: 1, textAlign: "center" }]}
              />
              <Button
                title="▶"
                variant="outline"
                compact
                accessibilityLabel="Next day"
                disabled={wornOn >= localIsoDate()}
                onPress={() => setWornOn((d) => shiftDate(d, 1))}
              />
            </View>
          </View>

          <View style={{ gap: theme.spacing(2) }}>
            <AppText variant="label" muted>
              Notes
            </AppText>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional: how did it wear?"
              placeholderTextColor={theme.colors.mutedForeground}
              multiline
              maxLength={MAX_MANICURE_NOTES_LENGTH}
              accessibilityLabel="Notes"
              style={[inputStyle(theme), { minHeight: 80, textAlignVertical: "top" }]}
            />
          </View>

          <View style={{ gap: theme.spacing(2) }}>
            <AppText variant="label" muted>
              Photo (optional)
            </AppText>
            {photo && (
              <Image
                source={{ uri: photo }}
                cachePolicy="none"
                contentFit="cover"
                accessibilityLabel="New mani photo"
                style={{ width: 120, height: 120, borderRadius: theme.radius.lg }}
              />
            )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
              <Button title={photo ? "Retake" : "Take a photo"} variant="outline" compact disabled={saving || preparingPhoto} onPress={() => void choosePhoto("camera")} />
              <Button title={photo ? "Replace" : "Choose photo"} variant="outline" compact disabled={saving || preparingPhoto} onPress={() => void choosePhoto("library")} />
              {photo && <Button title="Remove photo" variant="ghost" compact disabled={saving} onPress={() => setPhoto(null)} />}
            </View>
          </View>

          {error && <ErrorBanner message={error} />}
          <Button title="Log mani" variant="brand" loading={saving} disabled={preparingPhoto} onPress={() => void save()} testID="log-mani-save" />
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function inputStyle(theme: ReturnType<typeof useTheme>) {
  return {
    borderWidth: 1,
    borderColor: theme.colors.input,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing(3),
    paddingVertical: theme.spacing(2.5),
    color: theme.colors.foreground,
    backgroundColor: theme.colors.card,
    fontSize: theme.font.body,
  } as const;
}
