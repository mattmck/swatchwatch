import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import type { ComponentProps, ReactNode } from "react";
import { View } from "react-native";
import type { CaptureCheckCandidate } from "swatchwatch-shared";
import type { RapidAddVerdict } from "@/lib/rapid-add";
import { confidenceLabel } from "@/lib/rapid-add";
import { useTheme } from "@/theme/theme";
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
  const tones: Record<Tone, { border: string; surface: string; icon: string }> = {
    owned: { border: theme.colors.warning, surface: theme.colors.warningSurface, icon: theme.colors.warning },
    wishlist: { border: theme.colors.brand.pink, surface: theme.colors.infoSurface, icon: theme.colors.brand.pink },
    dupe: { border: theme.colors.warning, surface: theme.colors.warningSurface, icon: theme.colors.warning },
    add: { border: theme.colors.info, surface: theme.colors.infoSurface, icon: theme.colors.info },
    neutral: { border: theme.colors.border, surface: theme.colors.card, icon: theme.colors.mutedForeground },
    done: { border: theme.colors.success, surface: theme.colors.successSurface, icon: theme.colors.success },
  };

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
    case "pick":
      tone = "neutral";
      icon = "help-circle";
      eyebrow = "A few possibilities";
      title = "Which one is it?";
      body = (
        <View style={{ gap: theme.spacing(2) }}>
          {verdict.candidates.map((c) => (
            <Button
              key={`${c.entityType}:${c.entityId}`}
              title={`${c.display} · ${confidenceLabel(c.confidence)}${c.ownership.relationship === "owned" ? " · owned" : c.ownership.relationship === "wishlisted" ? " · wishlist" : ""}`}
              variant="outline"
              compact
              disabled={busy !== null}
              onPress={() => props.onPick(c)}
              style={{ justifyContent: "flex-start" }}
            />
          ))}
        </View>
      );
      actions = <Button title="None of these" variant="ghost" compact onPress={props.onNoneOfThese} />;
      break;
    case "not-found":
      tone = "neutral";
      icon = "search-circle";
      eyebrow = "No match yet";
      title = "Not in the catalog";
      body = (
        <AppText variant="small" muted>
          We couldn&apos;t match this{verdict.gtin ? ` (barcode ${verdict.gtin})` : ""}. Photograph the label, search
          by name, or add it yourself{verdict.gtin ? " (we'll remember the barcode)" : ""}.
        </AppText>
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
      // Placeholder until the create card lands (Task 14).
      tone = "neutral";
      icon = "add-circle";
      eyebrow = "No match yet";
      title = verdict.card.shadeName ? `${verdict.card.brand} — ${verdict.card.shadeName}` : "Not in the catalog";
      actions = <Button title="Add manually" variant="outline" compact onPress={props.onAddManually} />;
      break;
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

  const colors = tones[tone];
  return (
    <View
      accessibilityLiveRegion="polite"
      testID={`verdict-${verdict.kind}`}
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
        <Button title="Scan next" variant="brand" compact onPress={props.onScanNext} />
        {actions}
      </View>
    </View>
  );
}
