import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "@/lib/api/types";
import { tableCsv } from "@/lib/chart-export";
import { cleanValues, columnsForField, fieldsFromSchema, missingRequired } from "@/lib/schema-form";
import { adaptSpec, allowedColumns, defaultSpec, specProblem } from "@/components/charts/chart-builder";
import { buildFilter } from "@/components/data/filter-bar";
import { precheckFile } from "@/components/datasets/upload";
import { toRecipe } from "@/app/(studio)/prepare/prepare-view";

const col = (name: string, kind: ColumnInfo["kind"]): ColumnInfo => ({ name, kind, dtype: "" });
const COLUMNS = [col("customer_id", "text"), col("segment", "categorical"), col("age", "numeric"), col("balance", "numeric"), col("signup", "datetime"), col("app", "boolean")];

describe("chart builder rules", () => {
  it("offers only kinds a chart type can use", () => {
    expect(allowedColumns("histogram", "x", COLUMNS).map((c) => c.name)).toEqual(["age", "balance"]);
    expect(allowedColumns("box", "x", COLUMNS).map((c) => c.name)).toEqual(["segment", "app"]);
    expect(allowedColumns("histogram", "y", COLUMNS)).toEqual([]);
  });

  it("starts with a count bar of the first category", () => {
    expect(defaultSpec(COLUMNS)).toMatchObject({ type: "bar", x: "segment", agg: "count" });
    expect(defaultSpec([col("x", "numeric")])).toMatchObject({ type: "histogram", x: "x" });
  });

  it("drops columns the new type cannot use and fills required ones", () => {
    const fromBar = adaptSpec({ type: "bar", x: "segment", y: "balance", agg: "mean" }, "scatter", COLUMNS);
    expect(fromBar.x).toBe("age"); // categorical x is not valid for scatter
    expect(fromBar.y).toBe("balance");
    const toHeatmap = adaptSpec({ type: "bar", x: "segment", agg: "mean", y: "age" }, "heatmap", COLUMNS);
    expect(toHeatmap).toMatchObject({ x: null, y: null, agg: "count" }); // one axis only → correlation matrix
  });

  it("explains incomplete specs instead of requesting them", () => {
    expect(specProblem({ type: "scatter", x: "age" })).toMatch(/numeric Y/);
    expect(specProblem({ type: "bar", x: "segment", agg: "mean" })).toMatch(/numeric Y/);
    expect(specProblem({ type: "bar", x: "segment", agg: "count" })).toBeNull();
    expect(specProblem({ type: "heatmap", x: "segment" })).toMatch(/both axes/);
    expect(specProblem({ type: "heatmap" })).toBeNull();
  });
});

describe("filter construction", () => {
  it("ignores empty input rather than sending an always-false filter", () => {
    expect(buildFilter("age", "numeric", "gt", "  ")).toBeNull();
    expect(buildFilter("", "numeric", "gt", "3")).toBeNull();
    expect(buildFilter("city", "categorical", "in", " , ")).toBeNull();
  });
  it("builds list, range, and null filters", () => {
    expect(buildFilter("city", "categorical", "in", "Almaty, Astana")).toEqual({ column: "city", op: "in", value: ["Almaty", "Astana"] });
    expect(buildFilter("age", "numeric", "between", "18", "")).toEqual({ column: "age", op: "between", value: ["18", null] });
    expect(buildFilter("age", "numeric", "is_null", "ignored")).toEqual({ column: "age", op: "is_null", value: null });
    expect(buildFilter("app", "boolean", "eq", "")).toEqual({ column: "app", op: "eq", value: "true" });
  });
});

describe("upload pre-check", () => {
  const accepted = [".csv", ".xlsx", ".parquet"];
  it("rejects unsupported, empty, and oversized files before uploading", () => {
    expect(precheckFile({ name: "a.csv", size: 10 }, accepted, 5)).toBeNull();
    expect(precheckFile({ name: "A.CSV", size: 10 }, accepted, 5)).toBeNull();
    expect(precheckFile({ name: "a.exe", size: 10 }, accepted, 5)).toMatch(/not a supported/);
    expect(precheckFile({ name: "noext", size: 10 }, accepted, 5)).toMatch(/not a supported/);
    expect(precheckFile({ name: "a.csv", size: 0 }, accepted, 5)).toMatch(/empty/);
    expect(precheckFile({ name: "a.csv", size: 6 * 1024 * 1024 }, accepted, 5)).toMatch(/limit is 5 MB/);
  });
});

describe("CSV export", () => {
  it("adds a BOM, quotes separators, and neutralises formula injection", () => {
    const csv = tableCsv(["name", "value"], [["=HYPERLINK(\"x\")", -5], ["a,b", null], ["@cmd", "+1"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\n");
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",-5`); // negative numbers stay numbers
    expect(lines[2]).toBe(`"a,b",`);
    expect(lines[3]).toBe(`'@cmd,+1`); // "+1" is numeric, so it is left alone
  });
});

describe("analysis forms from JSON Schema", () => {
  // Shape of a real params schema emitted by the API (value_concentration).
  const schema = {
    properties: {
      group: { title: "Group column", type: "string", "x-widget": "column", "x-kinds": ["categorical", "boolean", "text"] },
      value: { anyOf: [{ type: "string", "x-widget": "column", "x-kinds": ["numeric"] }, { type: "null" }], default: null, title: "Value column" },
      threshold: { type: "number", default: 0.8, minimum: 0.5, maximum: 0.99, title: "Threshold" },
    },
    required: ["group"],
    type: "object",
  };

  it("derives widgets, kinds, defaults, and bounds", () => {
    const fields = fieldsFromSchema(schema);
    expect(fields.map((f) => [f.name, f.widget, f.required])).toEqual([
      ["group", "column", true],
      ["value", "column", false],
      ["threshold", "number", false],
    ]);
    expect(fields[2]).toMatchObject({ default: 0.8, minimum: 0.5, maximum: 0.99 });
    expect(columnsForField(fields[1], COLUMNS).map((c) => c.name)).toEqual(["age", "balance"]);
  });

  it("reports missing required params and drops empty optionals", () => {
    const fields = fieldsFromSchema(schema);
    expect(missingRequired(fields, { threshold: 0.8 })).toEqual(["Group column"]);
    expect(cleanValues(fields, { group: "segment", value: null, threshold: 0.8 })).toEqual({ group: "segment", threshold: 0.8 });
  });
});

describe("preparation recipe", () => {
  it("removes UI keys and empty optionals so the recipe is reproducible", () => {
    const recipe = toRecipe([
      { key: 1, op: "fill_missing", columns: ["age"], strategy: "median", value: "" },
      { key: 2, op: "drop_duplicates", columns: [] },
      { key: 3, op: "rename", columns: [], mapping: {} },
    ]);
    expect(recipe).toEqual([{ op: "fill_missing", columns: ["age"], strategy: "median" }, { op: "drop_duplicates" }, { op: "rename" }]);
  });
});
