import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the real stack, not a mock: BASE_URL is the nginx container that
 * serves the built console and proxies /api to FastAPI, so every assertion
 * here exercises the same path an operator's browser would.
 *
 * Run from the repository root with:
 *   docker compose up -d --build
 *   docker compose exec -T postgres psql -U gender -d gender_db < database/seed.sql
 *   E2E_ADMIN_PASSWORD=<BOOTSTRAP_ADMIN_PASSWORD> ./e2e/run.sh
 */
const baseURL = process.env.BASE_URL || "http://localhost:8083";

export default defineConfig({
  testDir: "./tests",
  // Serial on purpose. The suite creates a camera and counts against shared
  // state; two files racing would fight over the camera-name uniqueness
  // constraint and over the same workers.
  fullyParallel: false,
  workers: 1,
  // Spec 02 waits for a CPU worker to load both models and count real people
  // off the demo stream, which takes a minute or two.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "results.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    // Logs in once as the bootstrap admin and writes e2e/.auth/admin.json
    // (cookie + localStorage tokens, exactly what a real login leaves
    // behind). "chromium" depends on it and starts every test already
    // signed in, with no login step of its own.
    { name: "setup", testMatch: /global\.setup\.js/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: ".auth/admin.json" },
      dependencies: ["setup"],
      testIgnore: [/global\.setup\.js/, /00-auth\.spec\.js/, /demo\.spec\.js/],
    },
    // 00-auth.spec.js runs signed out on purpose, to exercise the login page
    // and role boundaries themselves -- no storageState, but it still depends
    // on "setup" for the operator/viewer accounts that setup seeds.
    {
      name: "chromium-unauthenticated",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /00-auth\.spec\.js/,
      dependencies: ["setup"],
    },
    // A recorded tour for people to watch, not a correctness check: videos
    // and screenshots land in e2e/artifacts/. It signs in through the real
    // login page itself, and slowMo keeps the video watchable.
    //   E2E_DEMO=1 ./e2e/run.sh --project=demo
    {
      name: "demo",
      testMatch: /demo\.spec\.js/,
      use: { ...devices["Desktop Chrome"], launchOptions: { slowMo: 120 } },
    },
  ],
});
