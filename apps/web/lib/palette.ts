/**
 * Chart color roles. Hex values (not CSS variables) so exported SVG/PNG files keep their colors.
 *
 * Two themes, the same eight hues stepped per surface (dataviz reference order, never cycled):
 * - dark (the studio): validated on the panel #111215. All checks pass, including ≥3:1 contrast for every
 *   slot; worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3.
 * - light (the printable report): validated on #ffffff. Worst adjacent CVD ΔE 9.1, normal-vision ΔE 19.6;
 *   slots 3–5 sit below 3:1, so every chart ships a legend and a table view (relief rule).
 * Scatter uses only slots 1–3 (all-pairs safe).
 */
export type ChartTheme = {
  name: "dark" | "light";
  surface: string;
  ink: string;
  ink2: string;
  ink3: string;
  grid: string;
  axis: string;
  cursor: string;
  series: string[];
  other: string;
  missing: string;
  sequential: string[];
  divergingNeg: string;
  divergingPos: string;
  divergingMid: string;
};

export const OTHER_LABEL = "Other";

export const CHART_DARK: ChartTheme = {
  name: "dark",
  surface: "#111215",
  ink: "#eceef1",
  ink2: "#a3a8b2",
  ink3: "#80858f",
  grid: "#1d1e22",
  axis: "#2e3036",
  cursor: "#1b1c20",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  other: "#6b707a",
  missing: "#18191d",
  // Magnitude on a dark surface: near zero recedes into the surface, large values are bright.
  sequential: ["#14243b", "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6"],
  divergingNeg: "#3987e5",
  divergingPos: "#e66767",
  divergingMid: "#2a2c31",
};

export const CHART_LIGHT: ChartTheme = {
  name: "light",
  surface: "#ffffff",
  ink: "#161b26",
  ink2: "#4a5263",
  ink3: "#626b7e",
  grid: "#e8eaef",
  axis: "#c9ced8",
  cursor: "#eef0f3",
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  other: "#9aa1ad",
  missing: "#f4f5f7",
  sequential: ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"],
  divergingNeg: "#2a78d6",
  divergingPos: "#d03b3b",
  divergingMid: "#f0efec",
};

/** The studio's series order; prefer `useChartTheme().series` inside charts. */
export const SERIES = CHART_DARK.series;

export function seriesColor(name: string, index: number, theme: ChartTheme = CHART_DARK): string {
  if (name === OTHER_LABEL) return theme.other;
  return theme.series[index % theme.series.length];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

/** Sequential color for t ∈ [0, 1]. */
export function sequential(t: number, theme: ChartTheme = CHART_DARK): string {
  const ramp = theme.sequential;
  const clamped = Math.min(1, Math.max(0, t));
  const position = clamped * (ramp.length - 1);
  const low = Math.floor(position);
  const high = Math.min(ramp.length - 1, low + 1);
  return mix(ramp[low], ramp[high], position - low);
}

/** Diverging color for v ∈ [-1, 1]: two poles and a neutral gray midpoint (polarity, e.g. correlation). */
export function diverging(v: number, theme: ChartTheme = CHART_DARK): string {
  const clamped = Math.min(1, Math.max(-1, v));
  return clamped < 0 ? mix(theme.divergingMid, theme.divergingNeg, -clamped) : mix(theme.divergingMid, theme.divergingPos, clamped);
}

/** Readable ink on a filled cell: whichever of near-black or white contrasts more (crossover at L ≈ 0.179). */
export function inkOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? "#0b0c0e" : "#ffffff";
}
