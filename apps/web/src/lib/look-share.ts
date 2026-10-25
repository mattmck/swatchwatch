import type { PublicLookResponse, PublicLookStep } from "swatchwatch-shared";
import { LOOK_TEMPLATES, LOOK_FINISH_LABELS, LOOK_MOOD_LABELS, LOOK_OCCASION_LABELS } from "./looks";
import type { DetailStep } from "./looks-detail";

/**
 * Pure helpers for shareable looks: the owner's Share link dialog on `/polishes/looks` and the
 * public `/l/?token=…` page. Like the shared wishlist (`lib/wishlist-share.ts`), the web app is a
 * static export, so the token travels as a query parameter (read with `readShareToken`).
 *
 * The public payload carries no free text from the saved look: the page names the look and its
 * steps from the built-in template (`LOOK_TEMPLATES`), and the brand/shade names come from the
 * catalog.
 */
export { readShareToken } from "./wishlist-share";

const ROLE_LABELS: Record<PublicLookStep["role"], string> = { base: "Base", accent: "Accent", topper: "Topper" };

/** Absolute share URL for the owner to copy, from the page origin and the API's `path`. */
export function buildLookShareUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

/** The look's name from its built-in template, or a generic one for an unknown template. */
export function publicLookName(templateId: string): string {
  return LOOK_TEMPLATES.find((t) => t.id === templateId)?.name ?? "A nail look";
}

/** The template's description for the look, or null. */
export function publicLookDescription(templateId: string): string | null {
  return LOOK_TEMPLATES.find((t) => t.id === templateId)?.description ?? null;
}

/** "Sam's look" / "A SwatchWatch look": the line above the look's name. */
export function publicLookOwnerLine(displayName: string | null | undefined): string {
  const name = displayName?.trim();
  return name ? `Shared by ${name}` : "Shared from SwatchWatch";
}

/** "Date night · Bold · Holo" from the public vibe. */
export function publicLookVibeLine(vibe: PublicLookResponse["vibe"]): string {
  const parts = [LOOK_OCCASION_LABELS[vibe.occasion], LOOK_MOOD_LABELS[vibe.mood]];
  if (vibe.finish) parts.push(LOOK_FINISH_LABELS[vibe.finish]);
  return parts.filter(Boolean).join(" · ");
}

/**
 * A step's label: the template's label for the `nth` step of that role ("Accent nail", then "Tip"
 * for a look's second accent), else the role.
 */
export function publicStepLabel(templateId: string, role: PublicLookStep["role"], nth = 0): string {
  const template = LOOK_TEMPLATES.find((t) => t.id === templateId);
  return template?.steps.filter((s) => s.role === role)[nth]?.label ?? ROLE_LABELS[role];
}

/** Each step's label, counting repeated roles in order (a look can have two accents). */
export function publicStepLabels(templateId: string, steps: readonly Pick<PublicLookStep, "role">[]): string[] {
  const seen: Partial<Record<PublicLookStep["role"], number>> = {};
  return steps.map((step) => {
    const nth = seen[step.role] ?? 0;
    seen[step.role] = nth + 1;
    return publicStepLabel(templateId, step.role, nth);
  });
}

/**
 * The public steps as the Details drawer's step shape, so the page shows the same application
 * order and finish notes (`applicationOrder`, `finishNotes`). A color-chip step (no catalog polish)
 * reads as "any shade close to #RRGGBB".
 */
export function publicLookDetailSteps(look: PublicLookResponse): DetailStep[] {
  const labels = publicStepLabels(look.templateId, look.steps);
  return look.steps.map((step, index) => ({
    role: step.role,
    label: labels[index],
    targetHex: step.hex,
    polish: step.brand && step.name ? { brand: step.brand, name: step.name, finishes: step.finishes } : null,
  }));
}

/** What the public page shows, from the token and the load result. */
export type PublicLookView =
  | { kind: "loading" }
  | { kind: "ready"; look: PublicLookResponse }
  | { kind: "unavailable"; reason: "missing" | "revoked" | "not-found" | "rate-limited" | "error"; title: string; message: string };

/**
 * The page state: no or malformed token and 404 are "not found", 410 is "turned off" (revoked),
 * 429 is "rate-limited", anything else an error. `result` is undefined while loading.
 */
export function publicLookView(
  token: string | null,
  result: { ok: true; look: PublicLookResponse } | { ok: false; status?: number } | undefined
): PublicLookView {
  if (!token) {
    return { kind: "unavailable", reason: "missing", title: "Look unavailable", message: publicLookErrorMessage(404) };
  }
  if (!result) return { kind: "loading" };
  if (result.ok) return { kind: "ready", look: result.look };
  const reason = result.status === 410 ? "revoked" : result.status === 404 ? "not-found" : result.status === 429 ? "rate-limited" : "error";
  const title = reason === "revoked" ? "No longer shared" : "Look unavailable";
  return { kind: "unavailable", reason, title, message: publicLookErrorMessage(result.status) };
}

/** Viewer-facing message for a failed public look load. */
export function publicLookErrorMessage(status: number | undefined): string {
  if (status === 410) return "Its owner has stopped sharing this look.";
  if (status === 404) return "This look link doesn't exist, or the look was deleted.";
  if (status === 429) return "Too many requests for this look right now. Wait a minute and try again.";
  return "We couldn't load this look. Try again in a moment.";
}

/** Short privacy note shown in the owner's Share link dialog. */
export const LOOK_SHARE_PRIVACY_NOTE =
  "Anyone with the link can see this look's colors and, for catalog polishes, the brand, shade and finish, " +
  "plus the display name you choose. They can't see your email, which polishes you own, your notes, prices " +
  "or the rest of your collection; polishes you added that aren't in the shared catalog show as a color only. " +
  "Search engines are asked not to index the page. Turn the link off at any time and it stops working " +
  "immediately; deleting the saved look deletes the link too.";
