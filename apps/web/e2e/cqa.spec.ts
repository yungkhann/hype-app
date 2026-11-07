import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API_URL } from "../playwright.config";

/**
 * Conversation Quality Analytics, end to end through the real UI against the real API (its own server and
 * throwaway workspace, see playwright.config.ts). Data is the labelled development fixtures only, scored by
 * the deterministic development mock evaluator (not AI). The steps follow the hackathon demo:
 * import → checklist → evaluate → transcript evidence → appeal → reviewer override → replace a criterion →
 * re-evaluate → import another group and evaluate only the new conversations.
 */
test.describe.configure({ mode: "serial" });

const CQA = `${API_URL}/cqa`;
const CHECKLIST = "Development sample checklist (unofficial)";

async function completedEvaluations(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${CQA}/evaluations?status=completed&page_size=1`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).total as number;
}

async function waitForCompleted(request: APIRequestContext, total: number) {
  await expect.poll(() => completedEvaluations(request), { timeout: 60_000 }).toBe(total);
  const running = await request.get(`${CQA}/evaluations?status=running&page_size=1`);
  expect((await running.json()).total).toBe(0);
}

async function actAs(page: Page, role: "Operator" | "Reviewer") {
  const button = page.getByRole("group", { name: "Demo role" }).getByRole("button", { name: new RegExp(`^${role}`) });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("CQA 1 · import fixtures, create the sample checklist, evaluate with the mock", async ({ page, request }) => {
  // The overview reads the real API (no client-side data).
  const info = page.waitForResponse((r) => r.url().startsWith(`${CQA}/info`) && r.ok());
  await page.goto("/cqa");
  await info;
  await expect(page.getByRole("heading", { name: "Conversation quality", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

  const imported = page.waitForResponse((r) => r.url() === `${CQA}/imports` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Load FIXTURE", exact: true }).click();
  expect((await imported).status()).toBe(201);
  await expect(page.getByText("Fixtures FIXTURE: 6 conversations received")).toBeVisible();

  // All three languages arrive, labelled as fixtures; filters are server-side.
  await page.goto("/cqa/conversations");
  for (const id of ["fx-ru-001", "fx-ru-002", "fx-kz-001", "fx-kz-002", "fx-en-001", "fx-en-002"]) {
    await expect(page.getByRole("link", { name: id, exact: true })).toBeVisible();
  }
  const filtered = page.waitForResponse((r) => r.url().includes("/cqa/conversations?") && r.url().includes("language=KZ"));
  await page.goto("/cqa/conversations?language=KZ");
  await filtered;
  await expect(page.getByRole("link", { name: "fx-kz-001", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "fx-ru-001", exact: true })).toHaveCount(0);

  await page.goto("/cqa/checklists");
  await expect(page.getByText("The official checklist is entered here, not invented")).toBeVisible();
  await page.getByRole("button", { name: "Add development sample" }).click();
  await expect(page).toHaveURL(/\/cqa\/checklists\/[0-9a-f]{32}$/);
  await expect(page.getByRole("heading", { name: CHECKLIST })).toBeVisible();
  await expect(page.getByText("Dev sample · unofficial").first()).toBeVisible();

  await page.getByRole("button", { name: "Evaluate with v1" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Development mock, not AI")).toBeVisible();
  await dialog.getByRole("button", { name: "Queue evaluation" }).click();
  await expect(page.getByText("Queued 6 evaluations")).toBeVisible();
  await waitForCompleted(request, 6);

  await page.goto("/cqa/evaluations");
  const table = page.getByRole("table");
  await expect(table.getByText("Completed")).toHaveCount(6);
  await expect(table.getByText("Dev mock · not AI")).toHaveCount(6);
});

test("CQA 2 · evidence links into the transcript; appeal → reviewer override → recalculated score", async ({ page }) => {
  await page.goto("/cqa/conversations/fx-ru-001");
  await expect(page.getByTestId("final-score")).toContainText("66.3");
  await expect(page.getByText("Dev mock · not AI").first()).toBeVisible();
  // A runtime-param route: the sidebar highlight streams in after the prerendered shell.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Conversations" })).toHaveAttribute("aria-current", "page");

  // Evidence is a real message: clicking it scrolls to and marks that line, and the URL keeps it.
  const greeting = page.locator('li[data-criterion-id="greeting"]');
  await greeting.locator("> button").click();
  await greeting.getByRole("button", { name: "Show m6 in the transcript" }).click();
  await expect(page.locator('[data-message-id="m6"]')).toHaveAttribute("aria-current", "location");
  await expect(page).toHaveURL(/msg=m6/);
  await expect(page).toHaveURL(/criterion=greeting/);

  // Operator appeals the criterion.
  await greeting.getByRole("button", { name: "Appeal this score" }).click();
  const appeal = page.getByRole("dialog", { name: "Appeal a criterion score" });
  await appeal.getByLabel("Why is this score wrong?").fill("m6 is the bot, not the operator: the operator never greets the client.");
  const created = page.waitForResponse((r) => r.url() === `${CQA}/appeals` && r.request().method() === "POST");
  await appeal.getByRole("button", { name: "Submit appeal" }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByText("Appeal submitted")).toBeVisible();
  await expect(greeting.getByRole("link", { name: "View appeal" })).toBeVisible();

  // Reviewer overrides it with a mandatory explanation.
  await actAs(page, "Reviewer");
  await greeting.getByRole("link", { name: "Review appeal" }).click();
  await expect(page).toHaveURL(/\/cqa\/appeals\?appeal=[0-9a-f]{32}/);
  await expect(page.getByText("m6 is the bot, not the operator").first()).toBeVisible();
  await page.getByRole("radio", { name: /Override the score/ }).click();
  const submit = page.getByRole("button", { name: "Override and recalculate" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Explanation (required)").fill("Agreed: the greeting at m6 comes from the bot.");
  await submit.click();
  await expect(page.getByText("Score overridden").first()).toBeVisible();
  await expect(page.getByTestId("decision-totals")).toContainText("66.3 → 56.3");

  // The engine recalculated the final score; the original is kept next to it.
  await page.goto("/cqa/conversations/fx-ru-001");
  await expect(page.getByTestId("final-score")).toContainText("56.3");
  await expect(page.getByTestId("original-score")).toContainText("66.3");
  await expect(page.locator('li[data-criterion-id="greeting"]').getByText("Overridden")).toBeVisible();
});

test("CQA 3 · replace a criterion in the UI, re-evaluate, import another group and evaluate only new ones", async ({ page, request }) => {
  await page.goto("/cqa/checklists");
  await page.getByRole("link", { name: CHECKLIST }).click();
  await expect(page.getByRole("heading", { name: CHECKLIST })).toBeVisible();

  await page.getByRole("button", { name: "Replace Farewell (sample)" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Confirms the resolution");
  await dialog.getByLabel("What the evaluator must check").fill("Before closing, the operator confirms the client's issue is resolved.");
  await dialog.getByLabel("Change note").fill("Organizers replaced the farewell criterion");
  await dialog.getByRole("button", { name: "Replace and save v2" }).click();
  await expect(page.getByText("Version 2 saved")).toBeVisible();
  await expect(page.locator('tr[data-criterion-id="confirms_the_resolution"]')).toBeVisible();
  await expect(page.locator('tr[data-criterion-id="farewell"]')).toHaveCount(0);
  await expect(page.getByText(/Replaced\s+Farewell \(sample\)/)).toBeVisible();

  await page.getByRole("button", { name: "Evaluate with v2" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Queue evaluation" }).click();
  await expect(page.getByText("Queued 6 evaluations")).toBeVisible();
  await waitForCompleted(request, 12);

  await page.goto("/cqa/conversations/fx-en-001");
  await expect(page.locator('li[data-criterion-id="confirms_the_resolution"]')).toBeVisible();
  await expect(page.locator('li[data-criterion-id="farewell"]')).toHaveCount(0);

  // A second group arrives during the demo: import it and evaluate only what is new, without a redeploy.
  await page.goto("/cqa/conversations");
  await page.getByRole("button", { name: "Import…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Load FIXTURE-CONTROL" }).click();
  await expect(page.getByText("Fixtures FIXTURE-CONTROL: 2 conversations received")).toBeVisible();
  await expect(page.getByRole("link", { name: "fx-ru-101", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "fx-en-101", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Evaluate…" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Queue evaluation" }).click();
  await expect(page.getByText("Queued 2 evaluations")).toBeVisible();
  await waitForCompleted(request, 14);
});

test("CQA 4 · Kazakh transcript in the embeddable view (for a Dynamics 365 HTML component)", async ({ page }) => {
  await page.goto("/cqa/embed/conversations/fx-kz-001");
  await expect(page.locator('ol[aria-label="Transcript"][lang="kk"]')).toBeVisible();
  await expect(page.getByTestId("final-score")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});
