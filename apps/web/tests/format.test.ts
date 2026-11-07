import { describe, expect, it } from "vitest";
import type { SourceMeta } from "@/lib/api/types";
import { describeFilter, fmtBytes, fmtNumber, fmtPct, sourceText } from "@/lib/format";

const meta = (patch: Partial<SourceMeta> = {}): SourceMeta => ({
  dataset_id: "d1",
  dataset_name: "customers",
  n_rows_total: 6000,
  n_rows_used: 6000,
  filters: [],
  sampled: false,
  sample_size: null,
  aggregation: null,
  notes: [],
  ...patch,
});

describe("fmtNumber", () => {
  it("groups integers and trims decimals by magnitude", () => {
    expect(fmtNumber(1234567)).toBe("1,234,567");
    expect(fmtNumber(1234.567)).toBe("1,235");
    expect(fmtNumber(12.3456)).toBe("12.35");
    expect(fmtNumber(0.012345)).toBe("0.012");
  });
  it("respects explicit digits and shows a dash for missing values", () => {
    expect(fmtNumber(0.81234, 3)).toBe("0.812");
    expect(fmtNumber(null)).toBe("—");
    expect(fmtNumber(undefined)).toBe("—");
    expect(fmtNumber("")).toBe("—");
  });
  it("passes non-numeric text through unchanged", () => {
    expect(fmtNumber("abc")).toBe("abc");
  });
});

describe("fmtPct", () => {
  it("expects a value already in percent", () => {
    expect(fmtPct(12.345)).toBe("12.3%");
    expect(fmtPct(100)).toBe("100.0%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(Number.NaN)).toBe("—");
  });
});

describe("fmtBytes", () => {
  it("uses binary units", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(500 * 1024 * 1024)).toBe("500 MB");
  });
});

describe("describeFilter", () => {
  it("renders each operator family", () => {
    expect(describeFilter({ column: "age", op: "is_null", value: null })).toBe("age is empty");
    expect(describeFilter({ column: "age", op: "between", value: [18, 30] })).toBe("age 18–30");
    expect(describeFilter({ column: "city", op: "in", value: ["A", "B", "C", "D", "E"] })).toContain("+2");
  });
});

describe("sourceText (the provenance line)", () => {
  it("states rows used, filter status, sampling, and aggregation", () => {
    expect(sourceText(meta())).toBe("customers · n = 6,000 rows · unfiltered");
    const text = sourceText(
      meta({
        n_rows_used: 1200,
        filters: [{ column: "segment", op: "eq", value: "premium" }],
        sampled: true,
        sample_size: 1000,
        aggregation: "mean of balance_kzt",
      }),
    );
    expect(text).toContain("n = 1,200 of 6,000 rows");
    expect(text).toContain("filtered: segment");
    expect(text).toContain("sampled 1,000");
    expect(text).toContain("mean of balance_kzt");
  });
});
