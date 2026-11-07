import { describe, expect, it } from "vitest";
import {
  answerChoices,
  answerLabel,
  answerTypeSummary,
  blankCriterion,
  conversationQueryString,
  criterionIdFrom,
  criterionIssues,
  fmtClock,
  fmtMessageTime,
  fmtPoints,
  fmtScore,
  fmtShare,
  languageName,
  languageTag,
  moveItem,
  normalizeCriterion,
  outcomeOf,
  parseChecklistFile,
  scalePoints,
  SPEAKER_LABEL,
  spanMessageIds,
  splitHighlight,
  uniqueId,
  weightShares,
} from "@/lib/cqa/format";
import type { Criterion, InspectedSpan } from "@/lib/cqa/types";

const criterion = (patch: Partial<Criterion> = {}): Criterion => ({ ...blankCriterion([]), id: "greeting", name: "Greeting", ...patch });
const scale = (min: number, max: number, step = 1, labels: Record<string, string> = {}) => criterion({ answer_type: "scale", scale: { min, max, step, labels } });
const options = criterion({
  answer_type: "options",
  options: [
    { id: "full", label: "Fully", points: 2 },
    { id: "partial", label: "Partly", points: 1 },
    { id: "none", label: "Not at all", points: 0 },
  ],
});

describe("languages and speakers", () => {
  it("names the three dataset languages and maps KZ to the Kazakh BCP-47 tag", () => {
    expect(["RU", "KZ", "EN"].map(languageName)).toEqual(["Russian", "Kazakh", "English"]);
    expect(["RU", "KZ", "EN"].map(languageTag)).toEqual(["ru", "kk", "en"]);
  });

  it("keeps unknown language codes visible instead of guessing", () => {
    expect(languageName("UZ")).toBe("UZ");
    expect(languageName(null)).toBe("Unknown");
    expect(languageTag("UZ")).toBeUndefined();
  });

  it("labels every transcript role", () => {
    expect(SPEAKER_LABEL).toEqual({ client: "Client", operator: "Operator", bot: "Bot", system: "System", unknown: "Unknown" });
  });
});

describe("number formatting", () => {
  it("formats scores with at most one decimal and a dash when absent", () => {
    expect(fmtScore(84.5)).toBe("84.5");
    expect(fmtScore(100)).toBe("100");
    expect(fmtScore(70.0)).toBe("70");
    expect(fmtScore(null)).toBe("—");
    expect(fmtScore(Number.NaN)).toBe("—");
  });

  it("formats points to two decimals and shares as whole percents", () => {
    expect(fmtPoints(12.3456)).toBe("12.35");
    expect(fmtPoints(10)).toBe("10");
    expect(fmtShare(0.333)).toBe("33%");
    expect(fmtShare(undefined)).toBe("—");
  });

  it("formats voice offsets as m:ss or h:mm:ss", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65.9)).toBe("1:05");
    expect(fmtClock(3725)).toBe("1:02:05");
    expect(fmtClock(-1)).toBe("—");
  });

  it("shows the clock part of ISO message times and the source text otherwise", () => {
    expect(fmtMessageTime({ timestamp: "2025-03-01T10:15:30+05:00", at: "2025-03-01T10:15:30+05:00", offset_seconds: null })).toBe("10:15:30");
    expect(fmtMessageTime({ timestamp: "00:01:05", at: null, offset_seconds: 65 })).toBe("00:01:05");
  });
});

describe("outcomes and answers", () => {
  it("derives the outcome from the engine's normalized value without recomputing points", () => {
    expect(outcomeOf({ status: "scored", normalized: 1 })).toBe("met");
    expect(outcomeOf({ status: "scored", normalized: 0.5 })).toBe("partial");
    expect(outcomeOf({ status: "scored", normalized: 0 })).toBe("missed");
    expect(outcomeOf({ status: "na", normalized: null })).toBe("na");
    expect(outcomeOf({ status: "invalid", normalized: null })).toBe("invalid");
    expect(outcomeOf(null)).toBe("missing");
  });

  it("labels answers in the checklist's own terms", () => {
    expect(answerLabel(criterion(), true)).toBe("Yes");
    expect(answerLabel(criterion(), false)).toBe("No");
    expect(answerLabel(criterion(), null)).toBe("—");
    expect(answerLabel(criterion(), true, true)).toBe("Not applicable");
    expect(answerLabel(scale(0, 5, 1, { "4": "Good" }), 4)).toBe("4 on 0–5 · Good");
    expect(answerLabel(options, "partial")).toBe("Partly");
    expect(answerLabel(options, "unknown")).toBe("unknown");
  });

  it("lists every value a reviewer may choose", () => {
    expect(answerChoices(criterion()).map((c) => c.value)).toEqual([true, false]);
    expect(answerChoices(scale(1, 3)).map((c) => c.value)).toEqual([1, 2, 3]);
    expect(answerChoices(options).map((c) => c.label)).toEqual(["Fully (2 pts)", "Partly (1 pts)", "Not at all (0 pts)"]);
  });

  it("enumerates fractional scale points and rejects empty scales", () => {
    expect(scalePoints({ scale: { min: 0, max: 2, step: 0.5 } })).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(scalePoints({ scale: { min: 0.1, max: 0.3, step: 0.1 } })).toEqual([0.1, 0.2, 0.3]);
    expect(scalePoints({ scale: { min: 5, max: 5, step: 1 } })).toEqual([]);
  });

  it("summarizes the answer type for the checklist table", () => {
    expect(answerTypeSummary(criterion())).toBe("Yes / No");
    expect(answerTypeSummary(scale(0, 10, 2))).toBe("Scale 0–10 step 2");
    expect(answerTypeSummary(options)).toBe("3 options");
  });
});

describe("transcript helpers", () => {
  const messages = [0, 1, 2, 3, 4].map((index) => ({ id: `m${index}`, index }));
  const span = (start: number, end: number): InspectedSpan => ({
    start_message_id: `m${start}`,
    end_message_id: `m${end}`,
    start_index: start,
    end_index: end,
    message_count: end - start + 1,
    note: "",
  });

  it("expands inspected spans inclusively", () => {
    expect([...spanMessageIds([span(1, 3)], messages)]).toEqual(["m1", "m2", "m3"]);
    expect(spanMessageIds(undefined, messages).size).toBe(0);
  });

  it("splits a message around a valid evidence range and ignores invalid ones", () => {
    expect(splitHighlight("Здравствуйте, чем помочь?", 0, 12)).toEqual(["", "Здравствуйте", ", чем помочь?"]);
    expect(splitHighlight("Сәлеметсіз бе", 3, 99)).toEqual(["Сәлеметсіз бе", "", ""]);
    expect(splitHighlight("Hello", 3, 3)).toEqual(["Hello", "", ""]);
    expect(splitHighlight("Hello", null, null)).toEqual(["Hello", "", ""]);
  });
});

describe("conversation query string", () => {
  it("repeats array keys and drops empty values", () => {
    expect(
      conversationQueryString({ q: "", language: ["RU", "KZ"], status: ["not_evaluated"], min_score: 0, desc: false, page: 2, checklist_id: undefined }),
    ).toBe("?language=RU&language=KZ&status=not_evaluated&min_score=0&desc=false&page=2");
    expect(conversationQueryString({})).toBe("");
  });
});

describe("checklist editing", () => {
  it("computes configured weight shares", () => {
    expect(
      weightShares([
        { id: "a", weight: 30 },
        { id: "b", weight: 10 },
      ]),
    ).toEqual({ a: 0.75, b: 0.25 });
    expect(weightShares([])).toEqual({});
  });

  it("derives ids from names, including non-Latin names", () => {
    expect(criterionIdFrom("Greets the client!")).toBe("greets_the_client");
    expect(criterionIdFrom("Café service")).toBe("cafe_service");
    expect(criterionIdFrom("Приветствие клиента")).toBe("criterion");
    expect(uniqueId("greeting", ["greeting", "greeting_2"])).toBe("greeting_3");
    expect(uniqueId("closing", ["greeting"])).toBe("closing");
  });

  it("moves items one step and leaves out-of-range moves unchanged", () => {
    const items = ["a", "b", "c"];
    expect(moveItem(items, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(items, 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(items, 0, -1)).toBe(items);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("accepts a valid criterion", () => {
    expect(criterionIssues(criterion(), ["closing"])).toEqual([]);
    expect(criterionIssues(scale(0, 10, 0.5))).toEqual([]);
    expect(criterionIssues(options)).toEqual([]);
  });

  it("mirrors the backend's validation rules", () => {
    expect(criterionIssues(criterion({ id: "Bad Id" }))).toHaveLength(1);
    expect(criterionIssues(criterion(), ["greeting"])[0]).toContain("already used");
    expect(criterionIssues(criterion({ name: "  " }))).toEqual(["Name is required."]);
    expect(criterionIssues(criterion({ weight: 0 }))[0]).toContain("Weight");
    expect(criterionIssues(scale(5, 1))[0]).toContain("greater than the minimum");
    expect(criterionIssues(scale(0, 1, 0.3))[0]).toContain("whole number of steps");
    expect(criterionIssues(scale(0, 1000, 1))[0]).toContain("101 points");
    expect(criterionIssues(criterion({ answer_type: "options", options: [{ id: "only", label: "Only", points: 1 }] }))[0]).toContain("at least two");
    expect(
      criterionIssues(
        criterion({
          answer_type: "options",
          options: [
            { id: "a", label: "A", points: 0 },
            { id: "a", label: "", points: 0 },
          ],
        }),
      ),
    ).toEqual(["Option ids must be unique.", "Every option needs a label.", "At least one option must score above zero."]);
  });

  it("drops settings that do not apply to the answer type", () => {
    const normalized = normalizeCriterion({ ...options, answer_type: "binary", name: " Greeting ", na_allowed: false, na_rule: "stale rule" });
    expect(normalized).toMatchObject({ name: "Greeting", answer_type: "binary", scale: null, options: null, na_rule: "" });
    expect(normalizeCriterion(criterion({ answer_type: "scale", scale: null })).scale).toEqual({ min: 0, max: 5, step: 1 });
  });
});

describe("checklist import file", () => {
  const config = { sections: [], criteria: [criterion()] };

  it("reads an ATLAS export", () => {
    const parsed = parseChecklistFile(
      JSON.stringify({ format: "atlas-cqa-checklist/1", name: " Official v1 ", description: "From the PDF", origin: "official", version: 3, config }),
      "fallback",
    );
    expect(parsed).toEqual({ name: "Official v1", description: "From the PDF", origin: "official", config });
  });

  it("reads a bare configuration and names it after the file", () => {
    const parsed = parseChecklistFile(JSON.stringify({ ...config, scoring: { max_score: 10 } }), "my-checklist");
    expect(parsed.name).toBe("my-checklist");
    expect(parsed.origin).toBe("custom");
    expect(parsed.config.scoring).toEqual({ max_score: 10 });
  });

  it("rejects files without criteria; unknown origins fall back to custom", () => {
    expect(() => parseChecklistFile(JSON.stringify({ name: "x" }), "f")).toThrow("no criteria");
    expect(() => parseChecklistFile("not json", "f")).toThrow();
    expect(() => parseChecklistFile("null", "f")).toThrow();
    expect(parseChecklistFile(JSON.stringify({ origin: "hacked", ...config }), "f").origin).toBe("custom");
  });
});
