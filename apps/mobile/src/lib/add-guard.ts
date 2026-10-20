import { Alert, Platform } from "react-native";
import type { PolishDupesResponse } from "swatchwatch-shared";
import { getPolishDupes } from "@/api/client";

const GUARD_TIMEOUT_MS = 2000;

/**
 * Add guard (#266, web `lib/add-guard.ts`): before adding a not-owned shade, look up owned
 * near-dupes. Failures and slow responses never block the add (resolves to null).
 */
export async function fetchOwnedDupes(shadeId: string): Promise<PolishDupesResponse | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GUARD_TIMEOUT_MS));
  return Promise.race([getPolishDupes(shadeId, { limit: 3 }).catch(() => null), timeout]);
}

export type AddGuardChoice = "add" | "wishlist" | "cancel";

/** Ask whether to go ahead when the shade has owned dupes; resolves "add" when it has none. */
export async function confirmAddWithDupes(
  shadeId: string,
  target: "owned" | "wishlist",
): Promise<AddGuardChoice> {
  const dupes = await fetchOwnedDupes(shadeId);
  if (!dupes || dupes.dupeCount === 0) return "add";
  const best = dupes.dupes[0];
  const names = dupes.dupes.map((d) => `• ${d.brand} — ${d.name}`).join("\n");
  if (Platform.OS === "web") {
    // react-native-web's Alert.alert does nothing, so ask with two browser confirms that keep all
    // three outcomes: add anyway, wishlist instead (when adding), cancel.
    const message = `You own ${dupes.dupeCount === 1 ? "a close dupe" : `${dupes.dupeCount} close dupes`}:\n${names}`;
    const verb = target === "owned" ? "Add anyway" : "Wishlist anyway";
    if (globalThis.confirm?.(`${message}\n\n${verb}?`)) return "add";
    if (target === "owned" && globalThis.confirm?.("Add it to your wishlist instead?")) return "wishlist";
    return "cancel";
  }
  return new Promise((resolve) => {
    const buttons: Parameters<typeof Alert.alert>[2] = [
      { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
    ];
    if (target === "owned") buttons.push({ text: "Wishlist instead", onPress: () => resolve("wishlist") });
    buttons.push({ text: target === "owned" ? "Add anyway" : "Wishlist anyway", onPress: () => resolve("add") });
    Alert.alert(
      `You own ${dupes.dupeCount === 1 ? "a close dupe" : `${dupes.dupeCount} close dupes`}`,
      `${best?.grade === "high" ? "Near-identical" : "Close"} to what you already have:\n${names}`,
      buttons,
      { cancelable: true, onDismiss: () => resolve("cancel") },
    );
  });
}
