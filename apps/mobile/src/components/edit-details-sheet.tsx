import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { resolvePolishFinishes, type FinishType, type Polish, type PolishUpdateRequest } from "swatchwatch-shared";
import { listReferenceFinishTypes } from "@/api/client";
import { buildFinishOptions } from "@/lib/manual-add";
import { finishLabel } from "@/lib/finishes";
import {
  buildEditPatch,
  clampQuantity,
  currencyOptions,
  hasEditErrors,
  MAX_QUANTITY,
  nextEditRating,
  validateEditForm,
  type PolishEditErrors,
  type PolishEditForm,
} from "@/lib/polish-edit";
import { isOwnedPolish, localIsoDate } from "@/lib/status";
import { useTheme } from "@/theme/theme";
import { ColorField, Field, FinishField, FormInput, QuantityStepper, StarRating } from "./polish-form-fields";
import { AppText, Button, Card, Chip } from "./ui";

/**
 * "Edit details" sheet on the polish detail screen (web: the edit mode of `/polishes/new`):
 * rating, notes, bottles (owned only), purchase price + currency + date. Brand, shade name,
 * finishes and color belong to the shared catalog row, so they are shown read-only, except for
 * the caller's own private shade (`polish.ownSubmitted`), which its creator may keep correcting
 * (catalog write rule, #224). A saved rating or purchase date can be cleared.
 */
export function EditDetailsSheet(props: {
  visible: boolean;
  polish: Polish;
  /** Form to start from (the polish's values, or the draft of a save that failed). */
  initialForm: PolishEditForm;
  /** Field errors to show on opening (e.g. the shade name of a rename the API refused). */
  initialErrors?: PolishEditErrors;
  onClose: () => void;
  /** Called with the validated patch; the screen saves it optimistically. */
  onSave: (patch: PolishUpdateRequest, form: PolishEditForm) => void;
}) {
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      {/* Mounted only while open, so every opening starts from the given form. */}
      {props.visible && <SheetBody {...props} />}
    </Modal>
  );
}

function SheetBody({ polish, initialForm, initialErrors, onClose, onSave }: Parameters<typeof EditDetailsSheet>[0]) {
  const theme = useTheme();
  const [form, setForm] = useState<PolishEditForm>(initialForm);
  const [errors, setErrors] = useState<PolishEditErrors>(initialErrors ?? {});
  const finishes = resolvePolishFinishes(polish);
  const owned = isOwnedPolish(polish);
  const ownShade = Boolean(polish.ownSubmitted);
  const [finishTypes, setFinishTypes] = useState<FinishType[] | null>(null);
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);

  useEffect(() => {
    if (!ownShade) return;
    let cancelled = false;
    listReferenceFinishTypes()
      .then((res) => {
        if (!cancelled) setFinishTypes(res.finishTypes);
      })
      .catch(() => {
        // The built-in finishes stand in (same fallback as the add form).
      });
    return () => {
      cancelled = true;
    };
  }, [ownShade]);

  function update<K extends keyof PolishEditForm>(field: K, value: PolishEditForm[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field in errors) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function save() {
    const found = validateEditForm(form, polish, localIsoDate());
    setErrors(found);
    if (hasEditErrors(found)) return;
    const patch = buildEditPatch(form, polish);
    if (!patch) {
      onClose();
      return;
    }
    onSave(patch, form);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: theme.spacing(4),
            paddingVertical: theme.spacing(2),
          }}
        >
          <Button title="Cancel" variant="ghost" compact onPress={onClose} />
          <AppText variant="heading" accessibilityRole="header">
            Edit details
          </AppText>
          <Button title="Save" variant="brand" compact onPress={save} testID="edit-details-save" />
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }} keyboardShouldPersistTaps="handled">
          {ownShade ? (
            <>
              <AppText variant="small" muted>
                This is your own private polish, so you can correct its details until it&apos;s reviewed.
              </AppText>
              <Field label="Brand" required error={errors.brand}>
                <FormInput value={form.brand} onChangeText={(v) => update("brand", v)} autoCapitalize="words" invalid={Boolean(errors.brand)} />
              </Field>
              <Field label="Shade name" required error={errors.name}>
                <FormInput value={form.name} onChangeText={(v) => update("name", v)} autoCapitalize="words" invalid={Boolean(errors.name)} />
              </Field>
              <FinishField finishOptions={finishOptions} selected={form.finishes} onChange={(next) => update("finishes", next)} />
              <ColorField
                hex={form.hex}
                colorName={form.colorName}
                finishes={form.finishes}
                error={errors.hex}
                allowClear={!polish.vendorHex}
                onHexChange={(v) => update("hex", v)}
                onColorNameChange={(v) => update("colorName", v)}
              />
            </>
          ) : (
            <Card>
              <AppText style={{ fontWeight: "600" }}>
                {polish.brand} · {polish.name}
              </AppText>
              {finishes.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }}>
                  {finishes.map((finish) => (
                    <Chip key={finish} label={finishLabel(finish)} />
                  ))}
                </View>
              )}
              <AppText variant="tiny" muted>
                Catalog details are shared, so brand, shade, finishes and color can&apos;t be changed here.
              </AppText>
            </Card>
          )}

          <Field label="Rating" error={errors.rating}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <View style={{ flex: 1 }}>
                <StarRating value={form.rating} onChange={(star) => update("rating", nextEditRating(form.rating, star))} />
              </View>
              {form.rating > 0 && <Button title="Clear" variant="ghost" compact accessibilityLabel="Clear rating" onPress={() => update("rating", 0)} />}
            </View>
          </Field>

          {owned && (
            <Field label="Bottles" error={errors.quantity} hint="Out of this polish? Use “Archive (used up)” on the detail screen.">
              <QuantityStepper value={form.quantity} max={MAX_QUANTITY} onChange={(next) => update("quantity", clampQuantity(next))} />
            </Field>
          )}

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

          <Field label="Price paid" error={errors.price} hint="Per bottle. Leave empty for none.">
            <FormInput
              value={form.price}
              onChangeText={(v) => update("price", v)}
              placeholder="12.50"
              keyboardType="decimal-pad"
              accessibilityLabel="Price paid"
              invalid={Boolean(errors.price)}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
              {currencyOptions(polish.purchaseCurrency).map((code) => (
                <Chip key={code} label={code} selected={form.currency === code} onPress={() => update("currency", code)} />
              ))}
            </View>
          </Field>

          <Field label="Purchase date" error={errors.purchaseDate} hint="YYYY-MM-DD">
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <View style={{ flex: 1 }}>
                <FormInput
                  value={form.purchaseDate}
                  onChangeText={(v) => update("purchaseDate", v)}
                  placeholder="2026-03-04"
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  accessibilityLabel="Purchase date"
                  invalid={Boolean(errors.purchaseDate)}
                />
              </View>
              <Button title="Today" variant="outline" compact onPress={() => update("purchaseDate", localIsoDate())} />
              {form.purchaseDate !== "" && (
                <Button title="Clear" variant="ghost" compact accessibilityLabel="Clear purchase date" onPress={() => update("purchaseDate", "")} />
              )}
            </View>
          </Field>

          {hasEditErrors(errors) && (
            <AppText variant="small" style={{ color: theme.colors.destructive }}>
              Check the highlighted fields.
            </AppText>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
