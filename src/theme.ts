import OBR from "@owlbear-rodeo/sdk";
import type { Theme, ThemeColor } from "@owlbear-rodeo/sdk";
import type { AccentId, AccentPref } from "./prefs";

export const ACCENTS: Record<AccentId, ThemeColor> = {
  violet: { main: "#7c5cff", light: "#9c82ff", dark: "#5b3fd6", contrastText: "#ffffff" },
  aqua: { main: "#2fb8c6", light: "#5fd0db", dark: "#1f8b96", contrastText: "#062226" },
  amber: { main: "#dd9a34", light: "#eab766", dark: "#b47c22", contrastText: "#2b1a03" },
  rose: { main: "#e05a86", light: "#ea82a4", dark: "#b23e66", contrastText: "#ffffff" },
  green: { main: "#4caf72", light: "#72c793", dark: "#398a58", contrastText: "#ffffff" },
  blue: { main: "#3f8ce0", light: "#6ba7e8", dark: "#2c6bb0", contrastText: "#ffffff" },
};
export const ACCENT_ORDER: AccentId[] = ["violet", "aqua", "amber", "rose", "green", "blue"];

// Owlbear's theme colors have always been observed as 3/6-digit hex, but this is defensive: if a
// room ever hands back something we don't recognize (rgb()/rgba(), 8-digit hex with its own alpha,
// a CSS name), we fall back to that string completely unmodified rather than silently producing an
// opaque color — an unmodified opaque fallback is exactly what made the panel look non-transparent
// before this was hardened.
function hexToRgba(color: string, alpha: number): string {
  const trimmed = color.trim();
  const rgbFunc = trimmed.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgbFunc) {
    return `rgba(${rgbFunc[1]}, ${rgbFunc[2]}, ${rgbFunc[3]}, ${alpha})`;
  }
  const hexMatch = trimmed.match(/^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!hexMatch) {
    return trimmed;
  }
  let hex = hexMatch[1];
  if (hex.length === 3) {
    hex = hex.split("").map((c) => c + c).join("");
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let latestTheme: Theme | null = null;
let latestAccentPref: AccentPref = "auto";

function applyPanelVars(panel: HTMLElement) {
  if (!latestTheme) {
    return;
  }
  const isDark = latestTheme.mode === "DARK";
  const accent: ThemeColor =
    latestAccentPref === "auto" ? latestTheme.primary : ACCENTS[latestAccentPref];

  panel.style.setProperty("--bg-default", hexToRgba(latestTheme.background.default, 0.2));
  panel.style.setProperty("--bg-paper", hexToRgba(latestTheme.background.paper, 0.55));
  panel.style.setProperty("--bg-solid", hexToRgba(latestTheme.background.paper, 0.97));
  panel.style.setProperty("--text-primary", latestTheme.text.primary);
  panel.style.setProperty("--text-secondary", latestTheme.text.secondary);
  panel.style.setProperty("--text-disabled", latestTheme.text.disabled);
  panel.style.setProperty("--divider", isDark ? "rgba(255,255,255,.09)" : "rgba(20,18,30,.10)");
  panel.style.setProperty("--primary-main", accent.main);
  panel.style.setProperty("--primary-light", accent.light);
  panel.style.setProperty("--primary-dark", accent.dark);
  panel.style.setProperty("--primary-contrast", accent.contrastText);
}

/**
 * Keeps the panel's CSS variables in sync with Owlbear's real room theme (mode/background/text always
 * follow OBR; the accent color follows OBR too unless the player picked one of our own presets from
 * the settings modal - see prefs.ts). Returns a setter to call whenever the accent preference changes.
 */
export function watchTheme(panel: HTMLElement, initialAccentPref: AccentPref): (accentPref: AccentPref) => void {
  latestAccentPref = initialAccentPref;
  OBR.theme.getTheme().then((theme) => {
    latestTheme = theme;
    applyPanelVars(panel);
  });
  OBR.theme.onChange((theme) => {
    latestTheme = theme;
    applyPanelVars(panel);
  });
  return (accentPref: AccentPref) => {
    latestAccentPref = accentPref;
    applyPanelVars(panel);
  };
}
