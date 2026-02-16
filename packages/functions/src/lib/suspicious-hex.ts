/**
 * Identifies hex values that are likely vendor placeholders or defaults
 * rather than actual product colors.
 *
 * When `detectHexOnSuspiciousOnly` is enabled, AI image detection will
 * only run for products whose vendor hex is flagged as suspicious.
 */

const SUSPICIOUS_HEXES = new Set([
  // Pure black/white
  "#000000",
  "#FFFFFF",

  // Common gray defaults
  "#808080",
  "#C0C0C0",
  "#D3D3D3",
  "#A9A9A9",
  "#DCDCDC",
  "#F5F5F5",
  "#E0E0E0",
  "#BEBEBE",

  // Gray scale steps often used as placeholders
  "#111111",
  "#222222",
  "#333333",
  "#444444",
  "#555555",
  "#666666",
  "#777777",
  "#888888",
  "#999999",
  "#AAAAAA",
  "#BBBBBB",
  "#CCCCCC",
  "#DDDDDD",
  "#EEEEEE",
  "#F0F0F0",

  // Pure primary colors (unlikely to be real polish colors)
  "#FF0000",
  "#00FF00",
  "#0000FF",

  // Pure secondary colors
  "#FFFF00",
  "#FF00FF",
  "#00FFFF",
]);

/**
 * Returns true if the hex value looks like a vendor placeholder/default
 * rather than a real product color.
 *
 * Null/undefined/empty values are always considered suspicious.
 */
export function isSuspiciousHex(hex: string | null | undefined): boolean {
  if (!hex) {
    return true;
  }

  const normalized = hex.trim().toUpperCase();
  if (!normalized.startsWith("#")) {
    return SUSPICIOUS_HEXES.has(`#${normalized}`);
  }

  return SUSPICIOUS_HEXES.has(normalized);
}
