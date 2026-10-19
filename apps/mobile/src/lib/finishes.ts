/** "holographic" → "Holographic" (web: `finishLabel`). */
export function finishLabel(finish: string): string {
  return finish ? finish.charAt(0).toUpperCase() + finish.slice(1) : "";
}
