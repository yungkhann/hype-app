import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Every CQA page renders at desktop and phone widths (this file matches the mobile project's testMatch) without
 * horizontal page scroll or console errors. Setup is an idempotent fixture import only, so it does not disturb
 * the ordered demo flow in cqa.spec.ts. Screenshots go to e2e/.artifacts/screenshots (git-ignored).
 */
const CQA = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 8100}/api/v1/cqa`;
const SHOTS = path.resolve(__dirname, ".artifacts/screenshots");

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("CQA pages render at this width without overflow or errors", async ({ page, request }, testInfo) => {
  const imported = await request.post(`${CQA}/imports`, { data: { group_id: "FIXTURE", source: "fixture" } });
  expect(imported.ok()).toBe(true);
  const checklists = (await (await request.get(`${CQA}/checklists`)).json()) as { id: string }[];
  const routes = [
    "/cqa",
    "/cqa/conversations",
    "/cqa/conversations/fx-ru-001",
    "/cqa/conversations/fx-ru-002",
    "/cqa/evaluations",
    "/cqa/checklists",
    ...(checklists[0] ? [`/cqa/checklists/${checklists[0].id}`] : []),
    "/cqa/appeals",
    "/cqa/embed/conversations/fx-kz-001",
  ];

  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));

  for (const route of routes) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText("Application error");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    const name = `${testInfo.project.name}-${route.replace(/^\//, "").replace(/\//g, "-").replace(/[0-9a-f]{32}/, "detail")}.png`;
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  }
  expect(errors).toEqual([]);
});
