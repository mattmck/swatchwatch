import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import {
  BRAND_COLOR_TOKENS,
  THEME_COLORS,
  type ThemeColorScheme,
  type ThemeColorTokens,
} from "swatchwatch-shared";

/**
 * Mobile theme: the web's semantic colors (shared design tokens generated from
 * `apps/web/src/app/globals.css`) plus spacing/radius scales sized for touch.
 */
export interface Theme {
  scheme: ThemeColorScheme;
  colors: ThemeColorTokens & {
    brand: typeof BRAND_COLOR_TOKENS;
    /** Verdict / status tones (Tailwind amber/emerald/violet families on the web). */
    success: string;
    successSurface: string;
    warning: string;
    warningSurface: string;
    info: string;
    infoSurface: string;
  };
  spacing: (steps: number) => number;
  radius: { sm: number; md: number; lg: number; xl: number; pill: number };
  font: { title: number; heading: number; body: number; small: number; tiny: number };
}

function buildTheme(scheme: ThemeColorScheme): Theme {
  const dark = scheme === "dark";
  return {
    scheme,
    colors: {
      ...THEME_COLORS[scheme],
      brand: BRAND_COLOR_TOKENS,
      success: dark ? "#34d399" : "#047857",
      successSurface: dark ? "#064e3b66" : "#ecfdf5",
      warning: dark ? "#fbbf24" : "#b45309",
      warningSurface: dark ? "#78350f66" : "#fffbeb",
      info: dark ? BRAND_COLOR_TOKENS.lilac : BRAND_COLOR_TOKENS.purple,
      infoSurface: dark ? "#42107e4d" : "#ffd7f033",
    },
    spacing: (steps) => steps * 4,
    // The web's --radius is 0.625rem (10px).
    radius: { sm: 6, md: 8, lg: 10, xl: 14, pill: 999 },
    font: { title: 28, heading: 20, body: 16, small: 14, tiny: 12 },
  };
}

const LIGHT = buildTheme("light");
const DARK = buildTheme("dark");

const ThemeContext = createContext<Theme>(LIGHT);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const theme = useMemo(() => (scheme === "dark" ? DARK : LIGHT), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
