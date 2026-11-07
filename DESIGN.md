---
name: ATLAS — Data Intelligence Studio
description: A quiet near-black analytical instrument where the data is the brightest thing on screen and every number carries its source line.
colors:
  canvas: "#0a0b0d"
  sunken: "#0d0e11"
  panel: "#111215"
  raised: "#18191d"
  hover: "#1c1d22"
  line: "#1f2024"
  line-strong: "#2b2d32"
  control: "#61656e"
  ink: "#eceef1"
  ink-2: "#a3a8b2"
  ink-3: "#80858f"
  accent: "#3fb3a4"
  accent-hover: "#52c1b2"
  accent-press: "#34a093"
  accent-fg: "#04110e"
  accent-soft: "#162827"
  accent-ink: "#6fd1c3"
  critical: "#f17b72"
  critical-soft: "#2e1f20"
  warning: "#e3a33a"
  warning-soft: "#2b2419"
  good: "#4fbf86"
  good-soft: "#172822"
  info: "#6ea8f0"
  info-soft: "#1b2431"
  series-1: "#3987e5"
  series-2: "#d95926"
  series-3: "#199e70"
  series-4: "#c98500"
  series-5: "#d55181"
  series-6: "#008300"
  series-7: "#9085e9"
  series-8: "#e66767"
  paper: "#ffffff"
  paper-ink: "#161b26"
typography:
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.016em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: "1.25rem"
    letterSpacing: "-0.006em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.006em"
  dense:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "-0.006em"
    fontFeature: "tnum"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1rem"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.dense}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-disabled:
    backgroundColor: "{colors.line-strong}"
    textColor: "{colors.ink-3}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.dense}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-ghost:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.dense}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
  overlay:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  badge:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
  nav-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.dense}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "30px"
  nav-item-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  source-line:
    textColor: "{colors.ink-3}"
    typography: "{typography.caption}"
---

# Design System: ATLAS — Data Intelligence Studio

Tokens live in `apps/web/app/globals.css` (`@theme`) and are exposed as Tailwind utilities (`bg-panel`, `text-ink-2`,
`border-line`, `text-dense`, …). Chart colors live in `apps/web/lib/palette.ts` as hex (`CHART_DARK`, `CHART_LIGHT`)
so exported SVG/PNG files keep them. The frontmatter mirrors those two files; if they disagree, the code is what
ships, so fix this file.

## Overview

**Creative North Star: "The Darkroom"**

A darkroom is lit so that only the print glows. ATLAS works the same way: near-black and charcoal surfaces step up
in very small increments, hairlines sit at roughly 7% white, and chrome text is held back to two muted greys, so the
brightest things on any screen are the data itself: chart marks, table values, metric deltas. The density is that
of a professional tool used for hours under time pressure: 13px working text, 30px navigation rows, 32px controls,
tabular numerals wherever a number appears. Craft shows in precision, not ornament: consistent radii, quiet hover
steps, crisp focus, and transitions of 100–160ms that clarify state and never perform.

The system's signature is the **source line**, a small caption that closes every chart, KPI strip, model metric and
finding: dataset · n rows (of total) · filters · sampling/aggregation. The second signature is **⌘K**, a jump-to
palette for every page and dataset, so the whole studio is reachable from the keyboard. One mid-teal accent marks
only what you can act on, what is selected, and where focus is.

Two surfaces deliberately leave the dark studio. Pitch Mode goes darker still (pure black backdrop, slides on the
panel colour) for projection. The Report is a print preview: white paper with the light chart theme inside the dark
chrome, because it exists to be printed or saved as PDF. The look was pinned by the user as Linear-level craft in a
dark-first world; it is a visual reference only. No Linear code, logos, branding or assets are used.

Rejected on purpose: KPI-card grids with oversized gradient numbers, decorative charts, eyebrow labels above
headings, gradient text, glass or blur as decoration, nested cards, emoji or glyphs as icons, and colored side
stripes.

**Key Characteristics:**
- 220px sidebar in the canvas colour behind a hairline edge, plus a 48px top bar with a breadcrumb and the dataset switcher.
- Flat charcoal panels with hairline borders; only overlays cast a shadow.
- One accent, used for action, selection and focus, never as decoration.
- Geist with tabular numerals; Geist Mono only for column names, types and identifiers.
- A source line under every number that matters, and ⌘K to reach anything.
- Status is always icon + word + colour, never colour alone.

## Colors

A cool, nearly achromatic charcoal world in five small surface steps, one mid-teal accent, reserved status hues on
their own dark tints, and a separate chart palette stepped for the dark panel.

### Primary
- **Darkroom Teal** (accent, #3fb3a4): primary buttons, the selected tab underline, the focus ring, checked switches and checkboxes, the active nav icon. 7.3:1 on the panel. Hover lightens to accent-hover, pressed darkens to accent-press. Text on a teal fill is **Developer Black** (accent-fg, #04110e, 7.5:1), never white.
- **Teal Ink on Teal Mist** (accent-ink #6fd1c3 on accent-soft #162827, 8.5:1): selected list rows, the active dataset, links, and column names cited inside messages.

### Neutral
- **Canvas** (#0a0b0d): the page and the sidebar. **Sunken** (#0d0e11): inputs, checkboxes, the sidebar search field and table headers, a recess below the panel. **Panel** (#111215): every work section. **Raised** (#18191d): overlays, secondary buttons, the active nav row. **Hover** (#1c1d22): hover fill, neutral badges, the highlighted command row.
- **Hairline / Strong Hairline** (line #1f2024, line-strong #2b2d32): panel borders and dividers; overlay, menu and secondary-button borders.
- **Control Grey** (control, #61656e): input and checkbox borders, 3.2:1 on panel and sunken (WCAG 1.4.11).
- **Ink / Ink 2 / Ink 3** (#eceef1, #a3a8b2, #80858f): primary text 16.1:1; secondary text and labels 7.9:1; captions, section labels and source lines 5.1:1 on panel, never below 4.5:1 on any surface.

### Status (reserved)
- **Critical** (#f17b72 on #2e1f20, 5.9:1), **Warning** (#e3a33a on #2b2419, 7.0:1), **Good** (#4fbf86 on #172822, 6.7:1), **Info** (#6ea8f0 on #1b2431, 6.3:1). Each tint is used only with its own text colour and an icon.

### Chart palette
- Eight categorical series in fixed order (series-1 … series-8), validated against the panel with the dataviz validator: every pair passes the lightness band, chroma floor, CVD separation (worst adjacent ΔE 8.4) and ≥3:1 contrast. "Other" is a neutral grey (#6b707a). Sequential ramps run from near-surface navy to light blue; diverging runs blue ↔ neutral grey ↔ red. The report uses `CHART_LIGHT`, the same hues stepped for white paper.

### Named Rules
**The Brightest Thing Rule.** Data marks and values outrank chrome. Chrome text is ink-2 or ink-3; full ink is for headings, values and the active item. If a control is brighter than the chart beside it, the control is wrong.

**The One Accent Rule.** Teal means "act, selected, or focused" and nothing else: no teal headings, illustrations, borders for emphasis, or chart series.

**The Status Is Reserved Rule.** Critical, warning, good and info are never chart series and never decoration; they always ship with an icon and a word.

## Typography

**Body Font:** Geist (self-hosted via the `geist` package), fallback `ui-sans-serif, system-ui`
**Mono Font:** Geist Mono, fallback `ui-monospace, SF Mono`

**Character:** A neutral grotesk set slightly tight (−0.006em body, −0.016em headings) with tabular numerals, so numbers align in columns and the interface reads crisp rather than airy.

### Hierarchy
- **Headline** (600, 1.25rem, 1.4): page titles, one per page.
- **Title** (600, 0.8125rem, 1.25rem): panel and dialog titles.
- **Body** (400, 0.875rem, 1.45): descriptions and running text; page descriptions are capped at about 80ch.
- **Dense** (400, 0.8125rem, 1.25rem, tabular): tables, controls, buttons, navigation; the working size.
- **Label** (500, 0.75rem, 1rem): field labels, stat labels, sidebar section labels, command groups.
- **Caption** (400, 0.6875rem, 1rem): source lines, hints, badges, axis ticks.
- **Mono** (400, 0.75rem): column names, dtypes, ids, file names and hashes only.

### Named Rules
**The Tabular Rule.** Every number that can be compared is tabular (`font-variant-numeric: tabular-nums`) and right-aligned in tables.

**The Mono Means Data Rule.** Geist Mono marks things that are literally identifiers in the data, never a "technical" mood.

## Layout

Desktop is a fixed 220px sidebar plus a fluid content column with 32px side padding (16px on phones) and a 48px
sticky top bar. Pages cap at 1400px. Sections are panels in one- or two-column grids with 16px gaps; a page header
(title, description, actions on the right) sits 20px above the first section. Below 1024px the sidebar becomes a
272px drawer opened from the top bar, which also gains a search button for ⌘K. Tab lists scroll sideways instead of
wrapping on phones. Tables scroll inside their panel; the page itself never scrolls horizontally at 390px.

## Elevation & Depth

Flat by default, depth by tone: surfaces step canvas → sunken → panel → raised → hover, a few percent of lightness
each. Only floating layers (menus, popovers, dialogs, the command palette, the mobile drawer, toasts) cast a shadow,
on the raised surface with a strong hairline, entering with a 4px rise or pop over 120–160ms (`ease-out-quart`).

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 16px 40px -12px rgb(0 0 0 / 0.65), 0 4px 12px -4px rgb(0 0 0 / 0.45)`): every floating layer, nothing else.

### Named Rules
**The Flat-By-Default Rule.** A panel never casts a shadow. If something needs to feel above, it is an overlay; otherwise it is a tone step.

## Shapes

Three radii: 4px for chips, badges, key caps and heat-map cells; 6px for buttons, inputs, nav rows and menu items;
8px for panels, overlays and slides. Borders are 1px hairlines; the selected tab is a 2px teal underline. Chart bars
have rounded data ends; meters are fully rounded 6px tracks.

## Components

### Buttons
- **Shape:** 6px radius, 32px tall (28px small, 40px large), 13px medium text, icon 16px.
- **Primary:** teal fill with Developer Black text; at most one per panel, the workflow's next step. Disabled goes neutral (strong hairline fill, ink-3 text) so it never reads as selected; loading keeps the teal and shows a spinner.
- **Secondary:** raised fill, strong hairline, ink text; hover steps to the hover fill.
- **Ghost:** ink-2 text, hover fill on hover. **Danger:** secondary shape with critical text and a critical tint on hover.
- **Focus:** 2px teal outline, 2px offset, keyboard only.

### Inputs / Fields
- **Style:** sunken fill, 1px control-grey border, 6px radius, 32px; label above (Label), hint below (Caption).
- **Focus:** border turns teal plus a 25% teal outline. **Error:** critical border with `aria-invalid`. **Disabled:** hairline border, ink-3 text.
- Number fields keep a draft while typing and clamp on blur.

### Cards / Containers
- **Panel:** 8px radius, panel fill, hairline border, no shadow; header row 12px × 16px with a title and an ink-3 description, divided by a hairline. Panels never nest.
- **Notice:** status tint with its icon, 6px radius, no border.

### Navigation
- **Sidebar:** canvas fill, hairline right edge; product mark; a "Jump to… ⌘K" field; Label-size section labels in ink-3; 30px rows with ink-3 icons and ink-2 text; hover gives the hover fill; the active row is raised with ink text and a teal icon. API status sits at the foot.
- **Top bar:** 48px, canvas, hairline bottom; breadcrumb (group › page) on desktop; dataset switcher on the right.
- **Tabs:** 36px, ink-3 text, 2px teal underline on the active tab, inset hairline under the list.

### Command palette (signature)
- ⌘K or Ctrl+K anywhere. A 620px raised overlay 12vh from the top: search field, grouped results ("Go to", "Switch dataset") in 36px rows, the highlighted row on the hover fill with a teal icon, key hints drawn as icons in the footer. It is a combobox over a listbox; arrows move, Enter opens, Esc closes.

### Charts
- Hex colours from `lib/palette.ts` through a chart-theme context (dark in the studio, light in the report); exports keep the theme they were drawn in. Grid lines are near-invisible (#1d1e22), axes one step brighter, tick labels ink-3. Every chart has a title, a legend for two or more series, a table view, and a source line. Heat-map cells pick the higher-contrast ink; a correlation diagonal is muted.

### Source line (signature)
- Caption size, ink-3, a database icon, the dataset name in ink-2 medium, then n rows · filters · method, separated by middots. It closes every chart, KPI strip, model metric and finding.

## Do's and Don'ts

### Do:
- **Do** keep chrome text at ink-2 or ink-3 so data stays the brightest element (The Brightest Thing Rule).
- **Do** put a source line under every chart, KPI strip and metric table.
- **Do** use tone steps (canvas, sunken, panel, raised, hover) for depth and reserve the overlay shadow for floating layers.
- **Do** use teal only for the primary action, selection and focus, with Developer Black text on teal fills.
- **Do** step chart colours per theme from `lib/palette.ts` and re-run the palette validator when changing them.
- **Do** show status as icon + word + colour.

### Don't:
- **Don't** use sunken as a hover or chip fill; on dark surfaces it reads as a hole. Use hover or raised.
- **Don't** add eyebrow labels above headings, gradient text, decorative glass or blur, or coloured side stripes.
- **Don't** use emoji or Unicode glyphs as icons; icons come from lucide-react at 16px.
- **Don't** nest panels or turn KPIs into separate cards; a stat strip is one panel.
- **Don't** reuse status colours as chart series or the accent as a chart colour.
- **Don't** ship white text on the teal accent, or light-mode values inside the studio outside the report's paper.
