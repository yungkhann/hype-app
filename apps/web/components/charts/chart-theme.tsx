"use client";

import { createContext, useContext, type ReactNode } from "react";
import { CHART_DARK, CHART_LIGHT, type ChartTheme } from "@/lib/palette";

/**
 * Charts render with hex colors (so exports keep them), which CSS variables cannot switch. The studio is dark;
 * the printable report wraps its content in `<ChartThemeProvider theme="light">`.
 */
const ChartThemeContext = createContext<ChartTheme>(CHART_DARK);

export function ChartThemeProvider({ theme, children }: { theme: "dark" | "light"; children: ReactNode }) {
  return <ChartThemeContext.Provider value={theme === "light" ? CHART_LIGHT : CHART_DARK}>{children}</ChartThemeContext.Provider>;
}

export function useChartTheme(): ChartTheme {
  return useContext(ChartThemeContext);
}
