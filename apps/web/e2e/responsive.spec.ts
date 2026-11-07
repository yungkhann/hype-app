import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Every page renders at desktop and phone widths without horizontal page scroll or console errors.
 * Screenshots go to e2e/.artifacts/screenshots for manual review (git-ignored).
 */
const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 8100}/api/v1`;
const SHOTS = path.resolve(__dirname, ".artifacts/screenshots");
const ROUTES = ["/", "/overview", "/explorer", "/prepare", "/analysis", "/models", "/findings", "/challenge", "/report", "/present"];

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("pages render at this width without overflow or errors", async ({ page, request }, testInfo) => {
  // A synthetic dataset to look at (loading through the API keeps this test independent of W1–W6).
  const response = await request.post(`${API}/datasets/samples/transactions.csv`);
  expect(response.ok()).toBe(true);
  const dataset = await response.json();
  await page.addInitScript((id) => window.localStorage.setItem("atlas.activeDataset", id), dataset.id);

  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));

  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText("Application error");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    const name = `${testInfo.project.name}${route === "/" ? "-home" : route.replace(/\//g, "-")}.png`;
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: route !== "/present" });
  }
  expect(errors).toEqual([]);
});
