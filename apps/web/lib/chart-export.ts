import { CHART_DARK, type ChartTheme } from "@/lib/palette";
import { downloadBlob, slug } from "@/lib/utils";

const FONT = "Geist, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * Serialize a rendered chart SVG with a title and the source line baked in, so an exported image
 * never loses its provenance.
 */
export type LegendEntry = { label: string; color: string };

/** The export keeps the theme the chart was drawn in, so title, legend and source match its axes. */
export function chartSvgString(svg: SVGSVGElement, title: string, source: string, legend: LegendEntry[] = [], theme: ChartTheme = CHART_DARK): string {
  const width = svg.width.baseVal.value || svg.getBoundingClientRect().width;
  const height = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const header = legend.length > 1 ? 56 : 34;
  const footer = 28;
  const total = height + header + footer;
  const ns = "http://www.w3.org/2000/svg";
  const wrapper = document.createElementNS(ns, "svg");
  wrapper.setAttribute("xmlns", ns);
  wrapper.setAttribute("width", String(width));
  wrapper.setAttribute("height", String(total));
  wrapper.setAttribute("viewBox", `0 0 ${width} ${total}`);
  wrapper.setAttribute("font-family", FONT);

  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", theme.surface);
  wrapper.appendChild(background);

  const heading = document.createElementNS(ns, "text");
  heading.setAttribute("x", "12");
  heading.setAttribute("y", "22");
  heading.setAttribute("font-size", "14");
  heading.setAttribute("font-weight", "600");
  heading.setAttribute("fill", theme.ink);
  heading.textContent = title;
  wrapper.appendChild(heading);

  if (legend.length > 1) {
    let x = 12;
    for (const entry of legend) {
      const swatch = document.createElementNS(ns, "rect");
      swatch.setAttribute("x", String(x));
      swatch.setAttribute("y", "34");
      swatch.setAttribute("width", "10");
      swatch.setAttribute("height", "10");
      swatch.setAttribute("rx", "2");
      swatch.setAttribute("fill", entry.color);
      wrapper.appendChild(swatch);
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(x + 14));
      label.setAttribute("y", "43");
      label.setAttribute("font-size", "11");
      label.setAttribute("fill", theme.ink2);
      label.textContent = entry.label;
      wrapper.appendChild(label);
      x += 14 + entry.label.length * 6.2 + 14;
    }
  }

  clone.setAttribute("x", "0");
  clone.setAttribute("y", String(header));
  wrapper.appendChild(clone);

  const caption = document.createElementNS(ns, "text");
  caption.setAttribute("x", "12");
  caption.setAttribute("y", String(header + height + 18));
  caption.setAttribute("font-size", "11");
  caption.setAttribute("fill", theme.ink3);
  caption.textContent = `Source: ${source}`;
  wrapper.appendChild(caption);

  return new XMLSerializer().serializeToString(wrapper);
}

export function exportSvg(svg: SVGSVGElement, title: string, source: string, legend: LegendEntry[] = [], theme: ChartTheme = CHART_DARK) {
  const text = chartSvgString(svg, title, source, legend, theme);
  downloadBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), `${slug(title, "chart")}.svg`);
}

export async function exportPng(svg: SVGSVGElement, title: string, source: string, legend: LegendEntry[] = [], theme: ChartTheme = CHART_DARK, scale = 2) {
  const text = chartSvgString(svg, title, source, legend, theme);
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not rasterize the chart."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable in this browser.");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG export failed.");
    downloadBlob(blob, `${slug(title, "chart")}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function tableCsv(columns: string[], rows: unknown[][]): string {
  const escape = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    // Neutralize spreadsheet formula injection in exported cells.
    const safe = /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + [columns, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}
