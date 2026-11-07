import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against their OWN servers and a throwaway workspace, so they never touch the
 * team's datasets or the dev servers on 3000/8000. Everything binds to 127.0.0.1.
 * The browser lives inside node_modules (PLAYWRIGHT_BROWSERS_PATH=0): run `pnpm --filter web e2e:install` once.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_URL = `http://127.0.0.1:${API_PORT}/api/v1`;
const DATA_DIR = path.resolve(__dirname, "e2e/.artifacts/workspace");

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.artifacts/results",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // channel "chromium" = full Chrome for Testing in new headless mode. The headless-shell build does not
    // produce frames on some macOS versions (requestAnimationFrame never fires), which stalls every test.
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chromium" }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: [
    {
      command:
        `rm -rf '${DATA_DIR}' && mkdir -p '${DATA_DIR}' && cd ../api && ` +
        `ATLAS_DATA_DIR='${DATA_DIR}' ATLAS_CORS_ORIGINS='["http://127.0.0.1:${WEB_PORT}"]' ` +
        `exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT}`,
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_ATLAS_API=http://127.0.0.1:${API_PORT} pnpm exec next build && ` +
        `NEXT_TELEMETRY_DISABLED=1 pnpm exec next start --hostname 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
