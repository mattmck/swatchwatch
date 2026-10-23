import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { COLOR_FAMILY_LABELS, classifyColorFamily, type FinishType, type Polish } from "swatchwatch-shared";
import { createPolish, errorMessage, listAllPolishes, listReferenceFinishTypes } from "@/api/client";
import { ColorDot } from "@/components/swatch";
import { Field, FormInput, QuantityStepper, StarRating } from "@/components/polish-form-fields";
import { AppText, Button, Card, Chip, ErrorBanner } from "@/components/ui";
import { confirmAlreadyOwned, confirmDupes } from "@/lib/add-guard";
import { notifyCollectionChanged } from "@/lib/collection-events";
import { DEFAULT_LIGHTNESS_INDEX, HUE_STOPS, LIGHTNESS_STEPS, normalizeHexParam, pickerHex } from "@/lib/color-search";
import {
  MAX_QUANTITY,
  asWishlistRequest,
  buildCreateRequest,
  buildFinishOptions,
  clampQuantity,
  dupesForNewShade,
  findOwnedSameShade,
  hasErrors,
  initialManualAddForm,
  manualAddPrefillFromParams,
  nextRating,
  toggleFinish,
  validateManualAdd,
  type ManualAddErrors,
  type ManualAddForm,
} from "@/lib/manual-add";
import { useTheme } from "@/theme/theme";

/** A hue stop index into `HUE_STOPS`, or `"neutral"`. */
type HueChoice = number | "neutral";

const GUARD_TIMEOUT_MS = 2000;

/** Owned polishes for the add guard; a slow or failed load never blocks the add (null). */
function loadOwnedForGuard(): Promise<Polish[] | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GUARD_TIMEOUT_MS));
  return Promise.race([listAllPolishes({ status: ["owned"] }).catch(() => null), timeout]);
}

/**
 * Manual "Add a polish" (web: `/polishes/new`), for a bottle the catalog doesn't know. Opened
 * from Rapid Add's "Not in the catalog" verdict (with the scanned barcode and any typed brand /
 * shade) and from Search's empty result (with the query as the name). The barcode is sent with
 * the new polish so the API remembers it for this user (`user_shade_barcode`) and the next scan
 * matches. Before saving, owned near-dupes of the entered color are shown (add guard, computed
 * on device like the web form), and a polish already owned under the same brand + name is
 * opened instead of saved over. Nothing is saved until the user taps Add.
 */
export default function NewPolishScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ barcode?: string; barcodeFormat?: string; brand?: string; name?: string }>();
  const [prefill] = useState(() => manualAddPrefillFromParams(params));
  const [form, setForm] = useState<ManualAddForm>(() => initialManualAddForm(prefill));
  const [errors, setErrors] = useState<ManualAddErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [finishTypes, setFinishTypes] = useState<FinishType[] | null>(null);
  const [hue, setHue] = useState<HueChoice | null>(null);
  const [lightness, setLightness] = useState(DEFAULT_LIGHTNESS_INDEX);

  useEffect(() => {
    let cancelled = false;
    listReferenceFinishTypes()
      .then((res) => {
        if (!cancelled) setFinishTypes(res.finishTypes);
      })
      .catch(() => {
        // The built-in finishes stand in (same fallback as the web).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);
  const hex = normalizeHexParam(form.hex);
  const family = hex ? classifyColorFamily({ vendorHex: hex, finishes: form.finishes }) : null;

  function update<K extends keyof ManualAddForm>(field: K, value: ManualAddForm[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field in errors) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function pickColor(nextHue: HueChoice, nextLightness: number) {
    setHue(nextHue);
    setLightness(nextLightness);
    update("hex", pickerHex(nextHue === "neutral" ? null : HUE_STOPS[nextHue], nextLightness));
  }

  async function submit() {
    setSubmitError(null);
    const found = validateManualAdd(form);
    setErrors(found);
    if (hasErrors(found)) return;
    setSubmitting(true);
    try {
      let request = buildCreateRequest(form, prefill);
      const owned = await loadOwnedForGuard();
      // Already owned under this brand + name: saving would overwrite that row's status and
      // bottle count through the create upsert, so open it instead.
      const existing = owned ? findOwnedSameShade(form, owned) : null;
      if (existing) {
        if ((await confirmAlreadyOwned(`${existing.brand} ${existing.name}`)) === "view") {
          router.replace({ pathname: "/polishes/[id]", params: { id: existing.id } });
        }
        return;
      }
      // Add guard (#266): a brand-new shade has no id, so compare the entered color against
      // the owned collection with the shared dupe rule (skipped without a color).
      if (request.vendorHex) {
        const dupes = owned
          ? dupesForNewShade({ brand: form.brand, name: form.name, hex: request.vendorHex, finishes: form.finishes }, owned, {
              finishTypes,
            })
          : null;
        const choice = await confirmDupes(dupes, form.status);
        if (choice === "cancel") return;
        if (choice === "wishlist") request = asWishlistRequest(request);
      }
      const created = await createPolish(request);
      notifyCollectionChanged();
      if (created?.id) router.replace({ pathname: "/polishes/[id]", params: { id: created.id } });
      else router.back();
    } catch (err) {
      setSubmitError(errorMessage(err, "Couldn't add the polish."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }} keyboardShouldPersistTaps="handled">
        <AppText muted>Not in the catalog? Add it yourself. It stays private to you until it&apos;s reviewed.</AppText>

        {prefill.barcode && (
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
              <Ionicons name="barcode-outline" size={28} color={theme.colors.primary} />
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="label" muted>
                  Scanned barcode
                </AppText>
                <AppText style={{ fontVariant: ["tabular-nums"], fontWeight: "600" }} testID="manual-add-barcode">
                  {prefill.barcode}
                </AppText>
                <AppText variant="tiny" muted>
                  Saved with this polish so your next scan finds it. Only you see it.
                </AppText>
              </View>
            </View>
          </Card>
        )}

        <Field label="Brand" required error={errors.brand}>
          <FormInput
            value={form.brand}
            onChangeText={(v) => update("brand", v)}
            placeholder="e.g. Holo Taco"
            autoCapitalize="words"
            invalid={Boolean(errors.brand)}
          />
        </Field>

        <Field label="Shade name" required error={errors.name}>
          <FormInput
            value={form.name}
            onChangeText={(v) => update("name", v)}
            placeholder="e.g. Scattered Holo Taco"
            autoCapitalize="words"
            invalid={Boolean(errors.name)}
          />
        </Field>

        <Field label="Finish" hint="Tap in order: the first is the main finish.">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
            {finishOptions.map((option) => {
              const index = form.finishes.indexOf(option.value);
              return (
                <Chip
                  key={option.value}
                  label={index === 0 && form.finishes.length > 1 ? `${option.label} · main` : option.label}
                  selected={index >= 0}
                  onPress={() => update("finishes", toggleFinish(form.finishes, option.value))}
                />
              );
            })}
          </View>
        </Field>

        <Field label="Color" error={errors.hex} hint="Pick the closest color, or type a hex.">
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
                  value={form.hex}
                  onChangeText={(v) => {
                    setHue(null);
                    update("hex", v);
                  }}
                  placeholder="#C0392B"
                  autoCapitalize="characters"
                  maxLength={7}
                  accessibilityLabel="Color hex"
                  invalid={Boolean(errors.hex)}
                />
              </View>
              {form.hex ? (
                <Button
                  title="Clear"
                  variant="ghost"
                  compact
                  onPress={() => {
                    setHue(null);
                    update("hex", "");
                  }}
                />
              ) : null}
            </View>
            <FormInput
              value={form.colorName}
              onChangeText={(v) => update("colorName", v)}
              placeholder={family ? `Color name (default: ${COLOR_FAMILY_LABELS[family]})` : "Color name, e.g. Teal (optional)"}
              accessibilityLabel="Color name"
              autoCapitalize="words"
            />
          </View>
        </Field>

        <Field label="Status">
          <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
            <Chip label="I own it" selected={form.status === "owned"} onPress={() => update("status", "owned")} />
            <Chip label="Wishlist" selected={form.status === "wishlist"} onPress={() => update("status", "wishlist")} />
          </View>
        </Field>

        {form.status === "owned" && (
          <Field label="Bottles" error={errors.quantity}>
            <QuantityStepper value={form.quantity} max={MAX_QUANTITY} onChange={(next) => update("quantity", clampQuantity(next))} />
          </Field>
        )}

        <Field label="Rating" error={errors.rating}>
          <StarRating value={form.rating} onChange={(star) => update("rating", nextRating(form.rating, star))} />
        </Field>

        <Field label="Notes" error={errors.notes}>
          <FormInput
            value={form.notes}
            onChangeText={(v) => update("notes", v)}
            placeholder="Where you bought it, how many coats…"
            multiline
            invalid={Boolean(errors.notes)}
            style={{ minHeight: 88, textAlignVertical: "top" }}
          />
        </Field>

        {Object.values(errors).some(Boolean) && (
          <AppText variant="small" style={{ color: theme.colors.destructive }}>
            Check the highlighted fields.
          </AppText>
        )}
        {submitError && <ErrorBanner message={submitError} />}

        <Button
          title={form.status === "owned" ? "Add to collection" : "Add to wishlist"}
          variant="brand"
          loading={submitting}
          disabled={submitting}
          onPress={() => void submit()}
          testID="manual-add-submit"
        />
        <Button title="Cancel" variant="ghost" disabled={submitting} onPress={() => router.back()} />
      </ScrollView>
    </KeyboardAvoidingView>
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
