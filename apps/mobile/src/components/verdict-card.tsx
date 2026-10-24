import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { View } from "react-native";
import {
  canSubmitCreateCard,
  type CaptureBrandConflict,
  type CaptureBrandRef,
  type CaptureCheckCandidate,
  type CreateCardEdits,
  type CreateCardModel,
  type FinishName,
  type FinishType,
} from "swatchwatch-shared";
import { listReferenceFinishTypes } from "@/api/client";
import { normalizeHexParam } from "@/lib/color-search";
import { finishLabel } from "@/lib/finishes";
import { buildFinishOptions } from "@/lib/manual-add";
import type { CaptureFrameEntry, RapidAddVerdict } from "@/lib/rapid-add";
import { candidateBrandBadge, confidenceLabel } from "@/lib/rapid-add";
import { useTheme } from "@/theme/theme";
import { FrameStrip } from "./frame-strip";
import { ColorField, Field, FormInput } from "./polish-form-fields";
import { ColorDot } from "./swatch";
import { AppText, Button, Chip } from "./ui";

export type VerdictBusy = "owned" | "wishlist" | "bottle" | null;

export interface VerdictCardProps {
  verdict: RapidAddVerdict;
  busy: VerdictBusy;
  onAdd: (candidate: CaptureCheckCandidate, status: "owned" | "wishlist") => void;
  onAddBottle: (candidate: CaptureCheckCandidate, quantity: number) => void;
  onPick: (candidate: CaptureCheckCandidate) => void;
  onNoneOfThese: () => void;
  onScanLabel: () => void;
  /** "Not in the catalog": open the manual add form with the scanned barcode. */
  onAddManually: () => void;
  onScanNext: () => void;
  /** The create card's Add / Wishlist: add the bottle to the catalog as a new polish. */
  onCreate: (card: CreateCardModel, edits: CreateCardEdits, status: "owned" | "wishlist") => void;
  /** "Switch to <brand>": go through the brand read off the bottle from now on. */
  onSwitchBrand: (read: CaptureBrandRef) => void;
  /** This scan's frames; the not-found card shows the uploaded ones. */
  frames: readonly CaptureFrameEntry[];
}

type Tone = "owned" | "wishlist" | "dupe" | "add" | "neutral" | "done";

function openPolish(shadeId: string | null) {
  if (shadeId) router.push({ pathname: "/polishes/[id]", params: { id: shadeId } });
}

/**
 * The in-aisle answer for one scan (web: `components/rapid-add/verdict-card.tsx`), with the
 * native extras: wishlist and near-dupe verdicts, and adding only on an explicit tap. The
 * switch is exhaustive, so a new verdict kind fails type-checking until it has a layout.
 */
export function VerdictCard(props: VerdictCardProps) {
  const theme = useTheme();
  const { verdict, busy } = props;

  let tone: Tone;
  let icon: ComponentProps<typeof Ionicons>["name"];
  let eyebrow: string;
  let title: string;
  let body: ReactNode = null;
  let actions: ReactNode;
  const candidate = "candidate" in verdict ? verdict.candidate : null;

  switch (verdict.kind) {
    case "owned":
      tone = "owned";
      icon = "checkmark-done-circle";
      eyebrow = "Already in your collection";
      title = "You own this";
      body = (
        <AppText variant="small" muted>
          You have {verdict.quantity} {verdict.quantity === 1 ? "bottle" : "bottles"}. Nothing was added.
        </AppText>
      );
      actions = (
        <>
          {Boolean(verdict.candidate.shadeId) && (
            <Button title="View polish" variant="outline" compact onPress={() => openPolish(verdict.candidate.shadeId)} />
          )}
          {Boolean(verdict.candidate.shadeId) && (
            <Button
              title="I bought another"
              variant="outline"
              compact
              loading={busy === "bottle"}
              disabled={busy !== null}
              onPress={() => props.onAddBottle(verdict.candidate, verdict.quantity + 1)}
            />
          )}
        </>
      );
      break;
    case "wishlisted":
      tone = "wishlist";
      icon = "heart-circle";
      eyebrow = "On your wishlist";
      title = "You wanted this one";
      body = <AppText variant="small" muted>Buying it? Move it into your collection.</AppText>;
      actions = (
        <>
          <Button title="I bought it" compact loading={busy === "owned"}
              disabled={busy !== null} onPress={() => props.onAdd(verdict.candidate, "owned")} />
          {Boolean(verdict.candidate.shadeId) && <Button title="View polish" variant="outline" compact onPress={() => openPolish(verdict.candidate.shadeId)} />}
        </>
      );
      break;
    case "near-dupe": {
      tone = "dupe";
      icon = "copy";
      eyebrow = "New to you — but close";
      title = `You own ${verdict.dupes.dupeCount} close ${verdict.dupes.dupeCount === 1 ? "dupe" : "dupes"}`;
      body = (
        <View style={{ gap: theme.spacing(1.5) }}>
          {verdict.dupes.dupes.slice(0, 3).map((dupe) => (
            <View key={dupe.shadeId} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
              <ColorDot hex={dupe.displayHex} size={16} />
              <AppText variant="small" style={{ flex: 1 }} numberOfLines={1}>
                {dupe.brand} — {dupe.name}
              </AppText>
              <Chip label={dupe.grade === "high" ? "Near-identical" : "Close"} tone="warning" />
            </View>
          ))}
        </View>
      );
      actions = (
        <>
          <Button title="Add anyway" compact loading={busy === "owned"}
              disabled={busy !== null} onPress={() => props.onAdd(verdict.candidate, "owned")} />
          {Boolean(verdict.candidate.shadeId) && (
            <Button title="Wishlist" variant="outline" compact loading={busy === "wishlist"}
              disabled={busy !== null} onPress={() => props.onAdd(verdict.candidate, "wishlist")} />
          )}
        </>
      );
      break;
    }
    case "add":
      tone = "add";
      icon = "add-circle";
      eyebrow = "New to you";
      title = "You don't own this yet";
      actions = (
        <>
          <Button title="Add to collection" compact loading={busy === "owned"}
              disabled={busy !== null} onPress={() => props.onAdd(verdict.candidate, "owned")} />
          {Boolean(verdict.candidate.shadeId) && (
            <Button title="Wishlist" variant="outline" compact loading={busy === "wishlist"}
              disabled={busy !== null} onPress={() => props.onAdd(verdict.candidate, "wishlist")} />
          )}
        </>
      );
      break;
    case "pick": {
      const conflict = verdict.brandConflict ?? null;
      tone = "neutral";
      icon = "help-circle";
      eyebrow = "A few possibilities";
      title = "Which one is it?";
      body = (
        <View style={{ gap: theme.spacing(2) }}>
          {conflict && <BrandConflictNotice conflict={conflict} onSwitchBrand={props.onSwitchBrand} />}
          {verdict.candidates.map((c) => {
            const badge = candidateBrandBadge(c, conflict);
            return (
              <View key={`${c.entityType}:${c.entityId}`} style={{ gap: theme.spacing(1) }}>
                {badge && <Chip label={`${badge.source === "bottle" ? "Bottle" : "Typed"}: ${badge.name}`} tone="warning" />}
                <Button
                  title={`${c.display} · ${confidenceLabel(c.confidence)}${c.ownership.relationship === "owned" ? " · owned" : c.ownership.relationship === "wishlisted" ? " · wishlist" : ""}`}
                  variant="outline"
                  compact
                  disabled={busy !== null}
                  onPress={() => props.onPick(c)}
                  style={{ justifyContent: "flex-start" }}
                />
              </View>
            );
          })}
        </View>
      );
      actions = <Button title="None of these" variant="ghost" compact onPress={props.onNoneOfThese} />;
      break;
    }
    case "not-found":
      tone = "neutral";
      icon = "search-circle";
      eyebrow = "No match yet";
      title = "Not in the catalog";
      body = (
        <View style={{ gap: theme.spacing(2) }}>
          <FrameStrip frames={props.frames.filter((f) => f.status === "uploaded")} onRetry={noop} onRemove={noop} />
          <AppText variant="small" muted>
            We couldn&apos;t match this{verdict.gtin ? ` (barcode ${verdict.gtin})` : ""}. Photograph the label, search
            by name, or add it yourself{verdict.gtin ? " (we'll remember the barcode)" : ""}.
          </AppText>
        </View>
      );
      actions = (
        <>
          <Button title="Photograph the label" compact onPress={props.onScanLabel} />
          <Button title="Add manually" variant="outline" compact onPress={props.onAddManually} />
          <Button title="Search by name" variant="outline" compact onPress={() => router.navigate("/search")} />
        </>
      );
      break;
    case "create":
      return <CreateVerdictCard {...props} verdict={verdict} />;
    case "added":
      tone = "done";
      icon = "checkmark-circle";
      eyebrow = verdict.status === "owned" ? "Saved" : "Saved for later";
      title = verdict.status === "owned" ? "Added to your collection" : "Added to your wishlist";
      body =
        verdict.quantity && verdict.quantity > 1 ? (
          <AppText variant="small" muted>
            You now have {verdict.quantity} bottles.
          </AppText>
        ) : null;
      actions = Boolean(verdict.candidate.shadeId) ? <Button title="View polish" variant="outline" compact onPress={() => openPolish(verdict.candidate.shadeId)} /> : null;
      break;
  }

  return (
    <VerdictShell
      kind={verdict.kind}
      tone={tone}
      icon={icon}
      eyebrow={eyebrow}
      title={title}
      candidate={candidate}
      body={body}
      actions={actions}
      onScanNext={props.onScanNext}
    />
  );
}

const noop = () => undefined;

/** The card frame shared by every verdict: icon, headline, body, and the action row after Scan next. */
function VerdictShell({
  kind,
  tone,
  icon,
  eyebrow,
  title,
  candidate,
  body,
  actions,
  onScanNext,
}: {
  kind: RapidAddVerdict["kind"];
  tone: Tone;
  icon: ComponentProps<typeof Ionicons>["name"];
  eyebrow: string;
  title: string;
  candidate: CaptureCheckCandidate | null;
  body: ReactNode;
  actions: ReactNode;
  onScanNext: () => void;
}) {
  const theme = useTheme();
  const tones: Record<Tone, { border: string; surface: string; icon: string }> = {
    owned: { border: theme.colors.warning, surface: theme.colors.warningSurface, icon: theme.colors.warning },
    wishlist: { border: theme.colors.brand.pink, surface: theme.colors.infoSurface, icon: theme.colors.brand.pink },
    dupe: { border: theme.colors.warning, surface: theme.colors.warningSurface, icon: theme.colors.warning },
    add: { border: theme.colors.info, surface: theme.colors.infoSurface, icon: theme.colors.info },
    neutral: { border: theme.colors.border, surface: theme.colors.card, icon: theme.colors.mutedForeground },
    done: { border: theme.colors.success, surface: theme.colors.successSurface, icon: theme.colors.success },
  };
  const colors = tones[tone];
  return (
    <View
      accessibilityLiveRegion="polite"
      testID={`verdict-${kind}`}
      style={{
        borderWidth: 2,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        borderRadius: theme.radius.xl,
        padding: theme.spacing(4),
        gap: theme.spacing(3),
      }}
    >
      <View style={{ flexDirection: "row", gap: theme.spacing(3), alignItems: "flex-start" }}>
        <Ionicons name={icon} size={32} color={colors.icon} />
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="label" muted>
            {eyebrow}
          </AppText>
          <AppText variant="heading" accessibilityRole="header">
            {title}
          </AppText>
          {candidate && (
            <AppText variant="small" style={{ fontWeight: "600" }} numberOfLines={2}>
              {candidate.display}
            </AppText>
          )}
        </View>
      </View>
      {body}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
        <Button title="Scan next" variant="brand" compact onPress={onScanNext} />
        {actions}
      </View>
    </View>
  );
}

/** "You typed X, the bottle reads Y" with a one-tap switch to the bottle's brand. */
function BrandConflictNotice({ conflict, onSwitchBrand }: { conflict: CaptureBrandConflict; onSwitchBrand: (read: CaptureBrandRef) => void }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(2) }} testID="brand-conflict">
      <AppText variant="small" muted>
        You typed {conflict.hinted.name}, but the bottle reads {conflict.read.name}.
      </AppText>
      <Button title={`Switch to ${conflict.read.name}`} variant="outline" compact onPress={() => onSwitchBrand(conflict.read)} />
    </View>
  );
}

/**
 * The bottle sequence's "add it as new" card: brand (confirmed when it was only read off the
 * bottle), shade name, color and finish prefilled from the scan. Nothing is saved until Add or
 * Wishlist is tapped.
 */
function CreateVerdictCard(props: VerdictCardProps & { verdict: Extract<RapidAddVerdict, { kind: "create" }> }) {
  const theme = useTheme();
  const { card, brandConflict } = props.verdict;
  const [brand, setBrand] = useState(card.brand);
  const [brandConfirmed, setBrandConfirmed] = useState(false);
  const [shadeName, setShadeName] = useState(card.shadeName);
  const [hexText, setHexText] = useState(card.hex ?? "");
  const [finish, setFinish] = useState<string | null>(card.finish);
  const [finishTypes, setFinishTypes] = useState<FinishType[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listReferenceFinishTypes()
      .then((res) => {
        if (!cancelled) setFinishTypes(res.finishTypes);
      })
      .catch(() => {
        // The built-in finishes stand in (same fallback as the manual add form).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finishOptions = useMemo(() => {
    const options = buildFinishOptions(finishTypes);
    const suggested = card.finish;
    if (suggested && !options.some((o) => o.value.toLowerCase() === suggested.toLowerCase())) {
      options.unshift({ value: suggested as FinishName, label: finishLabel(suggested) });
    }
    return options;
  }, [finishTypes, card.finish]);

  const hex = normalizeHexParam(hexText);
  const hexInvalid = hexText.trim() !== "" && !hex;
  const edits: CreateCardEdits = { brand, shadeName, hex, finish, brandConfirmed };
  const canSubmit = canSubmitCreateCard(card, edits) && !hexInvalid && props.busy === null;
  const confirmBrand = card.brandNeedsConfirm && brand === card.brand && !brandConfirmed;

  const body = (
    <View style={{ gap: theme.spacing(3) }}>
      {brandConflict && (
        <BrandConflictNotice
          conflict={brandConflict}
          onSwitchBrand={(read) => {
            setBrand(read.name);
            setBrandConfirmed(true);
            props.onSwitchBrand(read);
          }}
        />
      )}
      <Field label="Brand" required hint={confirmBrand ? "Read from the bottle. Check it, or fix it." : undefined}>
        <FormInput value={brand} onChangeText={setBrand} placeholder="Brand" autoCapitalize="words" />
        {confirmBrand && brand.trim() !== "" && (
          <Button title={`Yes, it's ${brand.trim()}`} variant="outline" compact onPress={() => setBrandConfirmed(true)} />
        )}
      </Field>
      <Field label="Shade name" required>
        <FormInput value={shadeName} onChangeText={setShadeName} placeholder="Shade name" autoCapitalize="words" />
      </Field>
      <ColorField
        hex={hexText}
        finishes={finish ? [finish as FinishName] : []}
        error={hexInvalid ? "Use a 6-digit hex such as #C0392B." : undefined}
        onHexChange={setHexText}
        hint="Pick the closest color, or type a hex. Optional."
      />
      <Field label="Finish">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
          {finishOptions.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={finish?.toLowerCase() === option.value.toLowerCase()}
              onPress={() => setFinish(finish?.toLowerCase() === option.value.toLowerCase() ? null : option.value)}
            />
          ))}
        </View>
      </Field>
    </View>
  );

  const actions = (
    <>
      <Button
        title="Add to collection"
        compact
        loading={props.busy === "owned"}
        disabled={!canSubmit}
        onPress={() => props.onCreate(card, edits, "owned")}
      />
      <Button
        title="Wishlist"
        variant="outline"
        compact
        loading={props.busy === "wishlist"}
        disabled={!canSubmit}
        onPress={() => props.onCreate(card, edits, "wishlist")}
      />
    </>
  );

  return (
    <VerdictShell
      kind="create"
      tone="add"
      icon="add-circle"
      eyebrow="Not in the catalog yet"
      title="Add it as new"
      candidate={null}
      body={body}
      actions={actions}
      onScanNext={props.onScanNext}
    />
  );
}
