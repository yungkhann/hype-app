---
version: 1
slug: "app-layout-tsx"
primary_target: "app/layout.tsx"
related_targets: []
---

# ATLAS app shell (all routes under apps/web/app)

Scope: every working screen of ATLAS (datasets, overview, explorer, prepare, analysis, models, findings, challenge) plus Pitch Mode and the report preview. Visitor mode: Operate (Pitch Mode is a projected Read surface inside the same world).

Audience/job: four developers at laptops through two long days and a night in a hall, moving an unknown dataset from upload to defensible findings; the jury reads Pitch Mode on a projector. The user pinned the direction on 2026-11-07: dark-first, Linear-level craft as the bar (reference only; no Linear code, logos, or assets), restrained accent, no gradients, no excess cards, every element analytical. This replaces the earlier navy-rail / off-white world.

## Direction contract

THESIS: A quiet, near-black analytical instrument where the data is the brightest thing on screen and every number carries its source line. Refuses the dark-dashboard default of glowing neon accents, gradient KPI tiles and card mosaics.

OWN-WORLD: Cool charcoal canvas (#0a0b0d) shared by sidebar and page; work sections one step up (#111215) on 7% white hairlines; 8px radii. Three ink levels (#eceef1 / #a3a8b2 / #80858f). One mid-teal (#3fb3a4) for the primary action, selection and focus only. Geist at 13px working size with slight negative tracking, 500/600 weights, tabular numerals; Geist Mono only for column names and ids. Charts in the dark-stepped categorical order on the panel surface.

STORY: The team drops an unfamiliar file, trusts the profile because detected facts are separated from heuristics, explores and models it, promotes evidence into findings, and presents them, moving between screens from the keyboard.

FIRST VIEWPORT: Left sidebar (220px, canvas colour, hairline edge): product mark, a Cmd+K search/jump field, workflow sections with 30px rows, API status at the foot. Main column: 48px top bar with breadcrumb-style page title and dataset switcher; page header (title 20px/600, one-line description); then the work sections. Datasets: workspace list, drop zone, synthetic samples.

FORM: Operate shell, sidebar plus top bar, standard web controls, command palette as the signature interaction. Canon path pinned by the user (Linear-level craft), position 1 of 1. seed: none (direction pinned by the user, which beats the roll; the roll needs a remote API call this project's network policy does not allow, so no dealt structure was used)

SIGNATURE: The source line under every chart, KPI strip, model metric and finding, plus Cmd+K to jump to any page or dataset.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
