import type { ChartData, ChartSpec, DatasetProfile, SourceMeta } from "@/lib/api/types";

/**
 * Build a ChartData from values that are already computed (profile, experiment metrics) so it can
 * use the same renderer, exports, and source line as API charts. Provenance must be supplied.
 */
export function localChart(spec: ChartSpec, fields: Omit<Partial<ChartData>, "spec" | "meta"> & { meta: SourceMeta }): ChartData {
  return {
    spec: {
      x: null,
      y: null,
      agg: "count",
      group: null,
      filters: [],
      bins: 30,
      time_bucket: "auto",
      columns: null,
      limit: 20,
      sort: "value_desc",
      ...spec,
    },
    x_label: null,
    y_label: null,
    x_kind: null,
    series: ["value"],
    rows: [],
    box: null,
    heatmap: null,
    warnings: [],
    ...fields,
  };
}

/** Provenance for statistics in a profile. Counts use every row; correlations may be sampled. */
export function profileMeta(profile: DatasetProfile, options: { sampled?: boolean; aggregation?: string; notes?: string[] } = {}): SourceMeta {
  const sampled = Boolean(options.sampled && profile.sampling.sampled);
  return {
    dataset_id: profile.dataset_id,
    dataset_name: profile.dataset_name,
    n_rows_total: profile.overview.n_rows,
    n_rows_used: sampled ? profile.sampling.sample_rows : profile.overview.n_rows,
    filters: [],
    sampled,
    sample_size: sampled ? profile.sampling.sample_rows : null,
    aggregation: options.aggregation ?? null,
    notes: options.notes ?? [],
  };
}
