import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Definition-of-Done workflows from the build brief, executed through the real UI against a real API
 * with synthetic data only. Tests share one throwaway workspace and run in order.
 */
test.describe.configure({ mode: "serial" });

async function loadSample(page: Page, filename: string) {
  await page.goto("/");
  await page.locator("li", { hasText: filename }).getByRole("button", { name: "Load" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("heading", { name: "Data quality" })).toBeVisible();
}

function syntheticCsv(rows = 48) {
  const lines = ["account_id;region;opened;balance;active"];
  const regions = ["north", "south", "east", "west"];
  for (let i = 0; i < rows; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    lines.push(`A${1000 + i};${regions[i % 4]};2026-03-${day};${(i * 137.5 + 20).toFixed(2)};${i % 3 === 0 ? "false" : "true"}`);
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

test("W1 · dataset inspection: upload CSV → schema → statistics → preview rows", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles({ name: "practice_accounts.csv", mimeType: "text/csv", buffer: syntheticCsv() });

  // Import review: detection results and a preview before anything is committed.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/delimiter/i).first()).toBeVisible();
  await expect(dialog.getByRole("columnheader", { name: /region/ })).toBeVisible();
  await dialog.getByTestId("confirm-import").click();

  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText("n = 48 rows").first()).toBeVisible();
  // Schema: every column with its detected kind.
  const columns = page.locator("section", { has: page.getByRole("heading", { name: "Columns" }) });
  for (const name of ["account_id", "region", "opened", "balance", "active"]) await expect(columns.getByText(name, { exact: true }).first()).toBeVisible();
  // Statistics for one column.
  await columns.getByText("balance", { exact: true }).first().click();
  await expect(page.getByText("Column detail")).toBeVisible();

  // Preview rows.
  await page.goto("/explorer");
  await expect(page.getByRole("cell", { name: "A1000" })).toBeVisible();
});

test("W2 · exploratory analysis: columns → filter → chart → save result", async ({ page }) => {
  await loadSample(page, "customers_churn.csv");
  await page.goto("/explorer");
  await expect(page.getByRole("columnheader", { name: /customer_id/ })).toBeVisible();

  // Select columns: hide the identifier.
  await page.getByRole("button", { name: /^Columns/ }).click();
  await page.locator("label", { hasText: "customer_id" }).getByRole("checkbox").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: /customer_id/ })).toHaveCount(0);

  // Filter records.
  await page.getByRole("button", { name: "Add filter" }).first().click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Filter column").selectOption("segment");
  await editor.getByLabel("Filter condition").selectOption("eq");
  await editor.getByLabel("Filter value").fill("premium");
  await editor.getByRole("button", { name: "Add filter" }).click();
  await expect(page.getByText(/n = [\d,]+ of 6,000 rows/).first()).toBeVisible();

  // Export the filtered rows (save result as data).
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Export [\d,]+ rows/ }).click()]);
  const csv = readFileSync(await download.path(), "utf-8");
  const lines = csv.trim().split("\n");
  expect(lines.length).toBeGreaterThan(100);
  expect(lines.length).toBeLessThan(6001);
  expect(lines[0]).not.toContain("customer_id");
  expect(lines.slice(1).every((line) => line.includes("premium"))).toBe(true);

  // Generate a chart, then save it as a finding.
  await page.getByRole("tab", { name: /Chart builder/ }).click();
  const chart = page.getByTestId("chart-view");
  await expect(chart.locator("svg.recharts-surface").first()).toBeVisible();
  await expect(chart.getByText(/filtered: segment = premium/)).toBeVisible();
  await page.getByRole("button", { name: "Save as finding" }).click();
  await page.getByTestId("save-finding").click();
  await expect(page.getByText("Finding saved")).toBeVisible();
});

async function trainAndExport(page: Page, target: string, primary: string) {
  await page.goto("/models");
  await page.getByTestId("model-target").selectOption(target);
  await expect(page.getByTestId("model-readiness").getByText("can train")).toBeVisible();
  await page.getByTestId("train-model").click();
  const report = page.getByTestId("experiment-report");
  await expect(report).toBeVisible({ timeout: 120_000 });
  const metrics = report.getByTestId("metrics-table");
  await expect(metrics.getByText("Dummy baseline")).toBeVisible();
  await expect(metrics.getByRole("cell", { name: new RegExp(`^${primary}`) })).toBeVisible();

  const [predictions] = await Promise.all([page.waitForEvent("download"), report.getByRole("link", { name: "Predictions" }).click()]);
  const rows = readFileSync(await predictions.path(), "utf-8").trim().split("\n");
  expect(rows.length).toBeGreaterThan(50);
  const [metricsFile] = await Promise.all([page.waitForEvent("download"), report.getByRole("link", { name: "Metrics" }).click()]);
  const payload = JSON.parse(readFileSync(await metricsFile.path(), "utf-8"));
  expect(payload.metrics[primary]).toEqual(expect.any(Number));
  expect(payload.baseline_metrics[primary]).toEqual(expect.any(Number));
  return payload;
}

test("W3 · classification: synthetic dataset → target → baseline → metrics → export", async ({ page }) => {
  await loadSample(page, "customers_churn.csv");

  // Typing key by key passes through out-of-range values ("0" on the way to "0.3"); the field must not rewrite them.
  await page.goto("/models");
  const share = page.getByLabel("Validation share");
  await share.fill("");
  await share.pressSequentially("0.3");
  await expect(share).toHaveValue("0.3");
  await share.fill("");
  await share.pressSequentially("0.9");
  await share.blur();
  await expect(share).toHaveValue("0.5"); // clamped to the maximum on blur
  await share.fill("0.2");
  await share.blur();

  const payload = await trainAndExport(page, "churned", "roc_auc");
  expect(payload.task).toBe("classification");
  expect(payload.metrics.roc_auc).toBeGreaterThan(payload.baseline_metrics.roc_auc);
});

test("W4 · regression: synthetic dataset → target → baseline → metrics → export", async ({ page }) => {
  await loadSample(page, "credit_limits.csv");
  const payload = await trainAndExport(page, "approved_limit_kzt", "r2");
  expect(payload.task).toBe("regression");
  expect(payload.metrics.r2).toBeGreaterThan(0.5);
});

test("W5 · business findings: chart → finding → interpretation → presentation", async ({ page }) => {
  await page.goto("/findings");
  const card = page.getByTestId("finding-card").first();
  await expect(card.getByText("needs interpretation")).toBeVisible();
  await card.getByRole("button", { name: "Edit finding" }).click();
  const interpretation = "Premium customers are a minority of the base; churn analysis must weight them separately.";
  await card.getByLabel("Interpretation").fill(interpretation);
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(card.getByText(interpretation)).toBeVisible();
  await expect(card.getByText("needs interpretation")).toHaveCount(0);
  const title = (await card.getByRole("heading", { level: 2 }).textContent())!.trim();

  await page.goto("/present");
  const counter = page.getByTestId("slide-counter");
  await expect(counter).toHaveText(/^1 \/ \d+$/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText(/^3 \//);
  await page.keyboard.press("e");
  await page.getByTestId("attach-finding").selectOption({ label: title });
  await page.getByLabel("Solution title").fill("Practice run");
  await page.getByTestId("save-pitch").click();
  await expect(page.getByText("Pitch saved")).toBeVisible();
  await page.getByRole("button", { name: "Close editor" }).click();

  const slide = page.getByTestId("slide");
  await expect(slide.getByText(interpretation)).toBeVisible();
  await expect(slide.locator("svg.recharts-surface").first()).toBeVisible();
  await page.keyboard.press("Home");
  await expect(counter).toHaveText(/^1 \//);
  await expect(slide.getByRole("heading", { name: "Practice run" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(counter).toHaveText(/^(\d+) \/ \1$/);

  // Persisted: a reload shows the saved deck.
  await page.reload();
  await expect(page.getByTestId("slide").getByRole("heading", { name: "Practice run" })).toBeVisible();

  await page.goto("/report");
  await expect(page.getByTestId("report").getByText(interpretation)).toBeVisible();
});

test("W6 · extension: a registered analysis is exposed by FastAPI and rendered in Next.js", async ({ page }) => {
  await loadSample(page, "branches.parquet");
  await page.goto("/analysis");
  await page.getByRole("button", { name: "Value concentration (Pareto)" }).click();
  await page.getByTestId("run-analysis").click();
  await expect(page.getByRole("heading", { name: "Result · Value concentration" })).toBeVisible();
  await expect(page.getByText(/Groups making 80%/)).toBeVisible();
  await expect(page.getByTestId("chart-view").locator("svg.recharts-surface").first()).toBeVisible();

  // The challenge extension area runs its template analysis the same way.
  await page.goto("/challenge");
  await expect(page.getByText("awaiting case")).toBeVisible();
  await page.getByTestId("run-analysis").click();
  await expect(page.getByRole("heading", { name: /^Result · / })).toBeVisible();
});

test("command menu · ⌘K jumps to a page from the keyboard", async ({ page }) => {
  await loadSample(page, "branches.parquet");
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  await menu.getByLabel("Search commands").fill("model lab");
  await expect(menu.getByRole("option", { name: /Model Lab/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/models$/);
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Model Lab" })).toBeVisible();
});
