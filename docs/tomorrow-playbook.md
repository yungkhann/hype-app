# Tomorrow playbook

**Data Challenge: Doomsday** (Nazarbayev University, 7–8 Nov 2026). The case comes from Freedom, and the task
is unknown until the reveal. This page covers what to do from the reveal to the deadline.

> **ATLAS submits nothing.** It has no connection to the competition platform. A team member uploads the
> final deliverables (deck PDF, report PDF, predictions file, code archive) by hand, through the organizers'
> portal, after the team has reviewed them.

## Before the reveal

- [ ] `pnpm dev` is running. The sidebar says "API connected · local only", or `GET
      http://127.0.0.1:8000/api/v1/health` returns `"status": "ok"`.
- [ ] Every laptop has pulled `main` and ran `pnpm run bootstrap` after the last dependency change.
- [ ] Case files go into `data/private/` (git-ignored; create it with `mkdir -p data/private`) and are
      uploaded from there. The workspace copy in
      `data/workspaces/` is also git-ignored. Never put case data anywhere else in the repo.
- [ ] Practice data is ready: `customers_churn.csv` (B), `credit_limits.csv` (C, semicolon-delimited),
      `transactions.csv` (C/A, daily time series), `branches.parquet` (A/D/E, no label), and
      `accounts_messy.xlsx` (F, two sheets). Load them with **Load** on the Datasets page.

## Case-reveal checklist

These are the same nine items, in the same order, as the checklist on `/challenge`
(`apps/web/app/(studio)/challenge/challenge-view.tsx`). Ticks are stored per browser.

1. **Write the exact question and how it is judged.** Copy the evaluation criteria verbatim into a finding
   so the whole team sees it.
2. **Name the deliverable.** Score, ranking, segmentation, forecast, dashboard, recommendations — and its
   format.
3. **Load every provided file and read Overview.** Note detected issues separately from heuristic flags.
4. **Confirm the grain: what is one row?** Find the keys, the time column, and duplicates.
5. **Agree the metric / target definitions.** Record them as a finding before anyone builds on them.
6. **Decide whether ML is needed at all.** If descriptive analysis answers the question, skip Model Lab.
7. **Assign owners and internal deadlines.** See docs/team-handoff.md.
8. **Set CASE_TITLE in apps/api/app/challenge/router.py**
9. **Freeze the pitch structure two hours before the deadline**

Then choose the closest scenario below. Most cases mix two, typically F with one of A–E.

## Timing

Times are relative to the submission deadline **D**. Write the real clock times into a finding at the reveal.

| When | What |
| --- | --- |
| Reveal → +60 min | Checklist items 1–8. Every file loaded, grain and definitions written down, scenario chosen, owners named. |
| +60 min → D − 6 h | First complete pass: data cleaned (F), the core analysis or baseline model done, first findings saved. Aim for an ugly but complete story early. |
| D − 6 h → D − 3 h | Improve the strongest result. Check leakage and robustness. Fill in interpretation, implication and limitations on every finding. |
| **D − 2 h** | **Freeze the pitch structure** (item 9). After this, no new analyses or slides; only wording, numbers from existing findings, and fixes. |
| D − 2 h → D − 1 h | Rehearse on `/present` (`N` shows notes). Print `/report` to PDF. Export findings (`/findings` → Markdown/JSON). |
| D − 1 h → D − 30 min | Final exports (predictions CSV, metrics JSON). A human checks every file. |
| D − 30 min | A human uploads to the platform. Keep a buffer for portal problems. |

## Scenario A: descriptive analysis and KPIs, no ML

Typical asks: "what drives X", "where are we losing money", "build a dashboard / KPIs".

1. **Overview**: schema, missingness, and quality flags (detected vs heuristic).
2. **Explorer**: filters, group & aggregate, chart builder. Save the useful views.
3. **Analysis Lab**:
   - `value_concentration` (Pareto, Gini) for "who/what makes most of the total".
   - `group_comparison` (metric across groups).
   - `association_ranking` (which columns relate to a target).
   - `time_trend` (by day/week/month/quarter/year).
4. **Challenge**: replace `challenge_template_segment_kpis` with the case's own KPI definitions.

**Save as findings:**
- The KPI definitions.
- One finding per insight, each with its chart snapshot and source line.
- The concentration and trend results with their exact numbers.

**Pitfalls:**
- Sampling: some analyses run on up to 200 000 sampled rows. The source line says so; quote it.
- Filters: a chart that was filtered must say so. The source line includes the filters.
- Correlation is not cause. `association_ranking` ranks associations, nothing more.
- Leave identifiers out of group-bys unless the entity itself is the point.

**Pitch:**
- problem → the 3–5 strongest observations → recommendation → impact and limitations.
- No model slide is needed. Say explicitly that ML was not required.

## Scenario B: binary classification (churn, default, fraud label, approval)

1. **Overview**: the target's class balance and missingness. Remove rows with no label, or decide how to
   handle them.
2. **Prepare** (only if needed): parse dates, cast, fill missing, one-hot, scale.
   - **Add the split here** (`stratified` on the target, or `chronological` if time matters). Fitted steps
     then learn from train rows only (`fit_scope: train_only`).
   - Save as a derived dataset.
3. **Model Lab**:
   - Pick the target and run the readiness check (`/experiments/check`). Read every warning.
   - Train `dummy` first, then `logistic_regression`, then `random_forest` (and `catboost` if `/health`
     shows it is available).
4. Export `predictions.csv` and `metrics.json` for the best honest model.

**Save as findings:**
- The target definition and class balance.
- Baseline versus model on the primary metric (`roc_auc`, or `f1` without probabilities).
- The confusion matrix, the top feature importances (with the method), and the limitations.

**Pitfalls:**
- **Leakage.** `leakage_correlation` and `leakage_purity` are critical but **do not block training**. Exclude
  the column yourself, or explain why it is truly known before the outcome.
- `identifier_feature`: drop ids, account numbers and phone numbers. They memorize rows.
- `upstream_fit_leakage`: the dataset was prepared with steps fitted on all rows. Redo Prepare with a split.
- `class_imbalance` / `tiny_class`: accuracy is meaningless here. Quote ROC AUC/F1 against the dummy
  baseline.
- Time: if the label happens after a date, use a chronological split. A random split overstates the score.

**Pitch:**
- The baseline score next to the model score, the validation strategy in one sentence, the 3 strongest
  drivers, what a 1-point gain means in business terms, and what is not proven.

## Scenario C: regression, or a forecast-like target (amount, limit, volume)

1. **Overview** and **Explorer**: the target's distribution and outliers. Check the histogram in the chart
   builder.
2. **Prepare**:
   - `derive_log` for skewed targets or features, `derive_date_parts` for calendar effects, `derive_ratio`
     for per-unit metrics.
   - For time-ordered data, use a **chronological** split on the time column.
3. **Analysis Lab** `time_trend` for the series shape, and `group_comparison` for level shifts.
4. **Model Lab**: `dummy` (it predicts the mean), then `linear_regression`, `ridge`, `random_forest` and
   `catboost`. Read the predicted-vs-actual and residual charts.

**Save as findings:** the target definition, RMSE against the dummy baseline, the residual pattern, and the
drivers.

**Pitfalls:**
- ATLAS has **no dedicated time-series model** (no ARIMA, no lag features). A "forecast" here is regression
  on calendar features plus a chronological split. Say that in the methodology.
- Future information in features, such as totals that include the target period, is leakage.
- `leakage_correlation` fires at |r| ≥ 0.98 (`LEAKAGE_CORR` in `modeling/checks.py`). Check the column
  before excluding it.
- RMSE is in target units. Translate it into the business unit in the pitch.

**Pitch:**
- Error in business units against the naive baseline, where the model is wrong (from the residuals), and how
  the estimate would be used.

## Scenario D: segmentation / clustering

1. **Overview**: pick numeric behavioral features and drop identifiers.
2. **Prepare** (optional): `fill_missing`, `derive_log` for heavy tails, `derive_ratio`.
3. **Analysis Lab** `kmeans_segments`:
   - Features are standardized internally, and segment means are reported in original units.
   - Try k = 3–6 and compare the silhouette values.
   - It needs at least `k × 5` complete rows.
4. **Explorer / group_comparison**: describe each segment with non-clustering columns.

**Save as findings:** one finding per segment (size, defining features, business label), plus the silhouette
and the chosen k with the reason.

**Pitfalls:**
- K-means is sensitive to the feature choice. Write down which features were used.
- Segment names are interpretations. Put them in the interpretation field, not as computed facts.
- Do not cluster on identifiers or the outcome you later "explain".

**Pitch:**
- A segment table (size, profile, action per segment) and the expected impact of acting on one segment.

## Scenario E: anomaly detection (fraud without labels, data quality, outliers)

1. **Overview**: detected quality flags (duplicates, impossible values) are anomalies too. List them
   separately.
2. **Analysis Lab** `anomaly_scores` (Isolation Forest):
   - Choose numeric features and set the expected anomaly share (0.1–20%).
   - It needs at least 50 complete rows and lists the top rows.
3. **Explorer**: filter to the flagged rows and inspect them by hand.
4. If labels exist for even a few cases, check how many flagged rows are true cases. Otherwise say there is
   no ground truth.

**Save as findings:** the method and parameters, 3–5 inspected examples with why they look anomalous, and
how stable the flags are across different feature choices.

**Pitfalls:**
- The contamination share is an assumption, not a result. Do not report it as the "fraud rate".
- Scale and skew drive Isolation Forest. Consider `derive_log` first.

**Pitch:**
- What is flagged, how many, what one confirmed example looks like, and how an analyst would triage the list.

## Scenario F: messy multi-file or Excel data

1. **Datasets**: upload each file. In import review, set the sheet, delimiter, encoding, header row and
   decimal separator (`,` for European numbers), and watch the warnings ("Only one column was found…",
   "Encoding detection is uncertain…").
2. **Overview**: duplicates, text-encoded numbers and dates, and missingness.
3. **Prepare** recipe, previewed before saving:
   - `rename`, `drop_duplicates`, `parse_dates` (with `format`), `cast`, `fill_missing`, `drop_missing` and
     `filter_rows`.
   - Each saved recipe creates a derived dataset with its step log, and the original stays untouched.
4. **Joining files: there is no join step in Prepare.** If the case needs a merge, the backend owner adds it
   in `apps/api/app/challenge/router.py`:
   - Load both frames with `DatasetService.frame`.
   - Merge them with pandas, on validated keys.
   - Store the result with `DatasetService.create_derived(parent_id, frame, name=..., lineage={...})`, so it
     gets a manifest, a profile and lineage like any other derived dataset.
   - Add a pytest. Check row counts before and after the merge: a fan-out from duplicate keys silently
     inflates totals.
5. If a file was wrong, use **Replace** on the Datasets page. It keeps the id and name and can be cancelled
   until the new file is imported.

**Save as findings:**
- A data-quality finding: what was wrong, what was fixed, and the row counts before and after.
- The join keys and their match rate.

**Pitfalls:**
- Fixing values by hand outside ATLAS breaks provenance. Record any manual edit in the methodology.
- Duplicate keys before a merge.
- Dates parsed day-first vs month-first. Check a few rows.

**Pitch:**
- One "data preparation" sentence in the methodology slide with the before/after counts. Do not spend
  slides on cleaning unless the case is about data quality.

## Extending each layer

| Need | Where | Owner |
| --- | --- | --- |
| A case-specific computation with summary + table + chart | `apps/api/app/challenge/analyses.py` (`category="challenge"`) | extension/backend dev |
| A bespoke endpoint (merge, scoring in the jury's format) | `apps/api/app/challenge/router.py`, then `pnpm gen:api` | extension/backend dev |
| Case-specific UI | `apps/web/app/(studio)/challenge/` | extension/backend dev |
| A new generic analysis | `apps/api/app/extensions/builtin.py` (see `docs/architecture.md`) | extension/backend dev |
| A new Prepare step | `apps/api/app/services/preprocessing/transforms.py` + `TransformStep.op` in `app/schemas/analysis.py` | extension/backend dev |

Every new analysis needs a pytest (see `apps/api/tests/test_findings_and_extensions.py`).

## Final deliverables

- [ ] Deck: present from `/present`. For a PDF, print `/report` ("Print / save as PDF"), or build the
      organizers' required format from the Markdown export.
- [ ] Findings: `/findings` → Markdown/JSON export (`atlas-findings.md`, `atlas-findings.json`).
- [ ] Model outputs, if any: `predictions.csv` and `metrics.json` from Model Lab.
- [ ] Every placeholder slide has been edited. `/present` keeps placeholders visibly marked.
- [ ] Every number in the deck traces to a finding with a source line.
- [ ] A human reviewed every file, then uploaded it to the platform. ATLAS does not do this step.
