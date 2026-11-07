# API contract

- Base URL: `http://127.0.0.1:8000/api/v1`. The port comes from `ATLAS_API_PORT`.
- Interactive docs are at `http://127.0.0.1:8000/docs`.
- The machine-readable contract is `docs/openapi.json`. Regenerate it with `pnpm gen:api`, which also
  regenerates `apps/web/lib/api/schema.d.ts`.
- The tables below were generated from the running app. When they disagree with `openapi.json`, the JSON
  file wins.

Path ids (`{dataset_id}`, `{experiment_id}`, `{finding_id}`, `{view_id}`) are 32-character lowercase hex.
A malformed id fails request validation with `422 invalid_request`.

## Endpoints

### system

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Status, version, `catboost` availability, `accepted_formats`, and the active limits (`max_upload_mb`, `max_rows`, `max_page_size`, `max_chart_points`, `profile_sample_rows`, `model_max_train_rows`). |

### datasets

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/datasets` | List datasets (summaries). |
| POST | `/datasets` | Stage an upload: store the original untouched, detect its format, and preview the first rows. Multipart: `file`, optional `name` (≤ 120 chars). Returns `201` with a `StagedPreview`. |
| GET | `/datasets/samples` | List the synthetic samples in `data/samples/`. |
| POST | `/datasets/samples/{filename}` | Stage and import a sample in one step. Returns `201`. |
| GET | `/datasets/{dataset_id}` | Dataset detail (manifest). |
| PATCH | `/datasets/{dataset_id}` | Rename. Body: `{"name": ...}`. |
| DELETE | `/datasets/{dataset_id}` | Delete the dataset and its files. |
| POST | `/datasets/{dataset_id}/stage-preview` | Re-parse the first rows of a staged upload with different options (sheet, delimiter, encoding). |
| POST | `/datasets/{dataset_id}/import` | Parse the whole staged file, store the canonical table, and profile it. Optional body: `IngestOptions`. |
| POST | `/datasets/{dataset_id}/replace` | Swap in a new file under the same dataset id and name; it must be imported again. Multipart: `file`. |
| POST | `/datasets/{dataset_id}/replace/cancel` | Discard a staged replacement and restore the previous version unchanged. |
| GET | `/datasets/{dataset_id}/preview?limit=` | First rows (`limit` 1–500, default 50). |
| GET | `/datasets/{dataset_id}/profile?refresh=` | Cached profile; `refresh=true` recomputes it. |
| POST | `/datasets/{dataset_id}/profile/refresh` | Recompute the profile. |
| GET | `/datasets/{dataset_id}/download?format=` | Download the processed table (`csv`, the default, or `parquet`) or the untouched `original` upload. |

### analysis (all under `/datasets/{dataset_id}`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/query` | Filter, search, sort, and page records. At most `limit` (≤ 500) rows are returned. |
| POST | `/aggregate` | Group and aggregate. |
| POST | `/visualize` | Build an aggregated, chart-ready series server-side (`ChartSpec`: bar, line, scatter, histogram, box, heatmap). |
| POST | `/transform` | Apply a recipe (1–50 steps, optional split) to a copy. `preview: true` returns the result without saving it; otherwise a new derived dataset is created and the source is left untouched. |
| POST | `/export` | Download every row matching the filters/search/sort as CSV (paging is ignored). |

The transform ops are `drop_columns`, `select_columns`, `rename`, `drop_duplicates`, `fill_missing`,
`drop_missing`, `parse_dates`, `cast`, `filter_rows`, `derive_date_parts`, `derive_ratio`, `derive_log`,
`bin_numeric`, `one_hot` and `scale`. The split strategies are `random`, `stratified` and `chronological`.

### analyses

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/analyses` | Every registered analysis with its parameter JSON schema (`x-widget` marks column pickers, `x-kinds` filters them). |
| POST | `/datasets/{dataset_id}/analyses/{analysis_id}` | Run one. Body: `{"params": {...}, "filters": [...]}`. Returns `AnalysisResult` (summary, table, chart, notes, source meta). |

The built-in ids are `value_concentration`, `group_comparison`, `association_ranking`, `kmeans_segments`,
`anomaly_scores` and `time_trend`. The challenge template is `challenge_template_segment_kpis`.

### models

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/models` | Model options and availability: `dummy`, `logistic_regression`, `linear_regression`, `ridge`, `random_forest`, `catboost`. |
| POST | `/experiments/check` | Validate a target/feature setup and report leakage hazards before training. |
| POST | `/experiments` | Queue training in the background. Returns `202`; poll `GET /experiments/{id}` for status. |
| GET | `/experiments?dataset_id=` | List experiments, optionally for one dataset. |
| GET | `/experiments/{experiment_id}` | Experiment detail: metrics, baseline metrics, confusion, importance, warnings. |
| DELETE | `/experiments/{experiment_id}` | Delete an experiment. |
| GET | `/experiments/{experiment_id}/predictions.csv` | Test-partition predictions: original row index, actual, predicted, and class probabilities. |
| GET | `/experiments/{experiment_id}/metrics.json` | Metrics, baseline, split, features, and warnings as a JSON download. |

The primary metric is `roc_auc` for binary classification (or `f1` when no probabilities are available),
`f1_macro` for multiclass, and `rmse` for regression (lower is better). The response reports it next to the
dummy baseline.

`/experiments/check` returns `warnings[]` with `code`, `severity` and `column`:

| Severity | Codes |
| --- | --- |
| critical | `target_unsupported`, `target_not_numeric`, `single_class`, `too_many_classes`, `no_features`, `too_few_rows`, `split_time_missing`, `split_time_type`, `leakage_correlation`, `leakage_purity` |
| warning | `identifier_feature`, `class_imbalance`, `tiny_class`, `target_missing`, `upstream_fit_leakage` |
| info | `datetime_feature`, `name_overlap`, `target_few_levels`, `stratify_regression` |

Training adds `stratify_disabled` (warning) and `train_sampled` (info) to the experiment.

`can_train` is false when there is a critical warning other than a leakage one. Leakage warnings do **not**
block training: exclude the column yourself.

### findings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/findings` | List findings in their saved order. |
| POST | `/findings` | Create a finding. Fields: title, description, optional chart snapshot, dataset/experiment refs, methodology, evidence (≤ 20), interpretation, implication, limitations, `include_in_pitch`. Returns `201`. |
| PUT | `/findings/order` | Reorder. Body: `{"ids": [...]}`, which must list every finding exactly once. |
| GET | `/findings/export.md` | Pitch and findings as a Markdown download. |
| GET | `/findings/export.json` | Pitch and findings as a JSON download. |
| GET / PATCH / DELETE | `/findings/{finding_id}` | Read, partially update, or delete one finding. |
| GET / PUT | `/pitch` | The pitch deck (default slides: title, problem, observations, solution, methodology, results, impact). Slide ids must be unique. |
| GET | `/views?dataset_id=` | Saved explorer views (chart or table). |
| POST | `/views` | Save a view. Returns `201`. |
| DELETE | `/views/{view_id}` | Delete a view. |

### challenge

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/challenge/info` | `status` (`"awaiting case"` or `"case revealed"`), `case_title` (from `CASE_TITLE` in `app/challenge/router.py`), and the analyses with `category="challenge"`. |

## Error envelope

Every handled failure has this shape (`app/core/errors.py`):

```json
{"error": {"code": "too_many_rows", "message": "6,000,000 rows exceeds the 5,000,000-row limit (raise ATLAS_MAX_ROWS to allow it).", "details": null}}
```

| Status | Default code | Codes raised in the code base |
| --- | --- | --- |
| 403 | — | `forbidden_origin` (OriginGuard; the message says to add the origin to `ATLAS_CORS_ORIGINS`) |
| 404 | `not_found` | `dataset_not_found`, `dataset_not_ready`, `invalid_id`, `sample_not_found`, `analysis_not_found`, `experiment_not_found`, `predictions_not_found`, `finding_not_found`, `view_not_found`; `not_found` itself for the original of a derived dataset |
| 409 | `conflict` | `conflict`: `replace/cancel` with nothing pending, or `import` on a derived dataset |
| 413 | `payload_too_large` | `payload_too_large` (upload above `ATLAS_MAX_UPLOAD_MB`), `file_too_large_uncompressed` (xlsx above `ATLAS_MAX_UNCOMPRESSED_MB`) |
| 422 | `validation_failed` | Ingestion: `unsupported_format`, `format_mismatch`, `unreadable_file`, `parse_error`, `encoding_error`, `empty_file`, `unknown_sheet`, `too_many_rows`, `too_many_columns`. Queries: `unknown_column`, `invalid_filter_value`, `invalid_filter_op`, `invalid_metric`, `invalid_chart`. Transforms: `invalid_step`, `invalid_split`, `empty_result`. Analyses: `invalid_param`, `empty_selection`, `too_few_rows`. Models: `cannot_train` (details = the check response), `model_task_mismatch`, `model_unavailable`, `unknown_model`, `single_class_train`, `invalid_split`, `invalid_param`. Findings: `invalid_order`, `invalid_pitch`. Storage: `unsafe_path` |
| 422 | — | `invalid_request`: FastAPI request validation, with `details` = `[{"loc": [...], "msg": "..."}]` |
| any | — | `http_error`: Starlette HTTP exceptions such as 404 for an unknown route or 405 |
| 500 | — | `internal_error`: a generic message; the traceback goes only to the API log |

The one response that is **not** the envelope: a request whose `Host` header is not in `ATLAS_ALLOWED_HOSTS`
gets Starlette's plain-text `400 Invalid host header`.

Messages from parsing libraries pass through `describe_error`, which replaces absolute paths with `<file>`
and caps them at 300 characters.

## Limits and settings

Settings come from environment variables with the `ATLAS_` prefix or from a `.env` file
(`app/core/config.py`, pydantic-settings). List values are JSON. Wrap them in single quotes in `.env`, because `scripts/dev.sh` sources it with bash,
which strips unquoted double quotes. For example: `ATLAS_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`.

| Env var | Default | Effect |
| --- | --- | --- |
| `ATLAS_MAX_UPLOAD_MB` | `500` | Upload size, enforced while streaming → `413 payload_too_large` |
| `ATLAS_MAX_UNCOMPRESSED_MB` | `4096` | Summed uncompressed size of an xlsx archive, checked before parsing → `413 file_too_large_uncompressed` |
| `ATLAS_MAX_ROWS` | `5000000` | Rows per dataset (Parquet footer, or reading stops at limit + 1) → `422 too_many_rows` |
| `ATLAS_MAX_COLUMNS` | `2000` | Columns per dataset → `422 too_many_columns` |
| `ATLAS_MAX_PAGE_SIZE` | `500` | Preview cap |
| `ATLAS_MAX_CHART_POINTS` | `5000` | Points per server-built chart |
| `ATLAS_MAX_SERIES` | `8` | Series per chart |
| `ATLAS_MAX_CATEGORIES` | `30` | Categories shown by built-in analyses |
| `ATLAS_PROFILE_SAMPLE_ROWS` | `200000` | Rows sampled for profiling and some charts/analyses (disclosed in source meta) |
| `ATLAS_MAX_CORRELATION_COLUMNS` | `30` | Columns in the correlation matrix |
| `ATLAS_MODEL_MAX_TRAIN_ROWS` | `200000` | Training rows; above this the train split is sampled (`train_sampled` warning) |
| `ATLAS_MODEL_WORKERS` | `2` | Training thread pool size |
| `ATLAS_DATAFRAME_CACHE_SIZE` | `4` | Parsed tables kept in memory |
| `ATLAS_DATA_DIR` | `data/workspaces` | Workspace root |
| `ATLAS_SAMPLES_DIR` | `data/samples` | Sample datasets |
| `ATLAS_CORS_ORIGINS` | `["http://localhost:3000","http://127.0.0.1:3000"]` | CORS and the OriginGuard allow-list; `scripts/dev.sh` derives it from `ATLAS_WEB_PORT` |
| `ATLAS_ALLOWED_HOSTS` | `["127.0.0.1","localhost"]` | Accepted `Host` headers (ports ignored) |

Request-level bounds: `query.limit` ≤ 500, `preview?limit` ≤ 500, transform steps ≤ 50, evidence items per
finding ≤ 20, names ≤ 120 characters.

## Downloads and CSV safety

| Endpoint | Content-Type | Filename |
| --- | --- | --- |
| `GET /datasets/{id}/download?format=csv` | `text/csv; charset=utf-8` | `<name>.csv` |
| `GET /datasets/{id}/download?format=parquet` | `application/octet-stream` | `<name>.parquet` |
| `GET /datasets/{id}/download?format=original` | `application/octet-stream` | the sanitized original filename |
| `POST /datasets/{id}/export` | `text/csv; charset=utf-8` | `<name> · filtered.csv` → `<name> _ filtered.csv` |
| `GET /experiments/{id}/predictions.csv` | `text/csv; charset=utf-8` | `<name> · predictions.csv` → `<name> _ predictions.csv` |
| `GET /experiments/{id}/metrics.json` | `application/json` | `<name> · metrics.json` → `<name> _ metrics.json` |
| `GET /findings/export.md` | `text/markdown; charset=utf-8` | `atlas-findings.md` |
| `GET /findings/export.json` | `application/json` | `atlas-findings.json` |

- `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded name>`
  (RFC 6266 / RFC 5987). Characters other than letters, digits and `._- ·()` are replaced with `_`, so quotes,
  CR/LF and path separators never reach the header. `filename*` carries the real name, so Cyrillic and Kazakh
  dataset or experiment names download intact; `filename` is an ASCII-only fallback (`export.csv` when nothing
  ASCII is left). CORS exposes this header. Covered by `tests/test_security.py`.
- CSV responses stream as UTF-8 with a BOM (so Excel shows Cyrillic correctly). Datetimes are written as
  `%Y-%m-%dT%H:%M:%S`.
- **Formula neutralization:** in every CSV response, a text cell that starts with `=`, `+`, `-`, `@`, tab or
  CR gets a leading `'`, so a spreadsheet will not execute it.
  - Numeric-looking text (`-5`) is left unchanged.
  - The exact values remain available as Parquet or as the original file.

## Dataset staging, replace and cancel

```
POST /datasets (file)            → status "staged": original stored, format detected, first 20 rows previewed
POST /datasets/{id}/stage-preview → re-preview with other IngestOptions (sheet, delimiter, encoding, header row)
POST /datasets/{id}/import        → status "ready": data.parquet written, profile computed
                                    (on error: status "failed" with the message; the original is kept)
```

- Preflight runs at staging and again at import.
- A file whose extension does not match its contents is refused (`format_mismatch`).

Replacing a dataset keeps its id and name:

1. `POST /datasets/{id}/replace` moves the current files into `datasets/{id}/previous/` and stages the new
   file (`replacing: true`). A second replace while one is pending discards only the pending file.
2. `POST /datasets/{id}/import` finalizes: the new table is written and `previous/` is deleted.
3. Or `POST /datasets/{id}/replace/cancel` deletes the pending file and moves `previous/` back. Nothing from
   the old version is changed. Without a pending replacement it returns `409 conflict`.

Derived datasets (from `/transform`) have `source: "transform"`, `lineage` (parent, steps, log, split) and
no original file.
