import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { resolvePolishFinishes, type Polish, type PolishUpdateRequest } from "swatchwatch-shared";
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
import { Field, FormInput, QuantityStepper, StarRating } from "./polish-form-fields";
import { AppText, Button, Card, Chip } from "./ui";

/**
 * "Edit details" sheet on the polish detail screen (web: the edit mode of `/polishes/new`):
 * rating, notes, bottles (owned only), purchase price + currency + date. Brand, shade name,
 * finishes and color belong to the shared catalog row, so they are shown read-only.
 */
export function EditDetailsSheet(props: {
  visible: boolean;
  polish: Polish;
  /** Form to start from (the polish's values, or the draft of a save that failed). */
  initialForm: PolishEditForm;
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

function SheetBody({ polish, initialForm, onClose, onSave }: Parameters<typeof EditDetailsSheet>[0]) {
  const theme = useTheme();
  const [form, setForm] = useState<PolishEditForm>(initialForm);
  const [errors, setErrors] = useState<PolishEditErrors>({});
  const finishes = resolvePolishFinishes(polish);
  const owned = isOwnedPolish(polish);

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

          <Field label="Rating" error={errors.rating}>
            <StarRating value={form.rating} onChange={(star) => update("rating", nextEditRating(form.rating, star, polish.rating))} />
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
