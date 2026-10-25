import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ADMIN_CREDENTIALS, SEED, settled as dataDrawn } from "./helpers.js";

/**
 * A recorded tour of the console for people to watch, not a correctness
 * check (01-07 are that). Each test opens its own recording context, walks
 * the console the way an operator would, and leaves a named video and a
 * screenshot per step in e2e/artifacts/:
 *
 *   artifacts/videos/01-desktop-dark.webm   login → every page → live camera
 *   artifacts/videos/02-desktop-light.webm  the same pages in light mode
 *   artifacts/videos/03-phone.webm          390 px wide, through the menu
 *   artifacts/screenshots/<tour>/NN-<step>.png
 *
 * Needs the stack up with database/seed.sql loaded; the seed's Main Entrance
 * camera is enabled on the demo stream, so the live view has people in it.
 * Opt-in, so the regular suite stays fast:
 *
 *   E2E_DEMO=1 E2E_ADMIN_PASSWORD=... ./e2e/run.sh --project=demo
 */

test.skip(process.env.E2E_DEMO !== "1", "the recorded tour runs only with E2E_DEMO=1");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(__dirname, "..", "artifacts");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// Long enough for a viewer to take in each page.
const pause = (page, ms = 1800) => page.waitForTimeout(ms);

/** A fresh context recording at its own viewport size, plus a shot() helper. */
async function startTour(browser, name, { viewport = DESKTOP, mode = "dark", ...options } = {}) {
  const shots = path.join(ARTIFACTS, "screenshots", name);
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(path.join(ARTIFACTS, "videos"), { recursive: true });

  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport,
    recordVideo: { dir: test.info().outputPath("video"), size: viewport },
    ...options,
  });
  await context.addInitScript((m) => localStorage.setItem("gender:color-mode", m), mode);
  const page = await context.newPage();

  let step = 0;
  const shot = async (label, { fullPage = false } = {}) => {
    step += 1;
    const file = `${String(step).padStart(2, "0")}-${label}.png`;
    await page.screenshot({ path: path.join(shots, file), fullPage });
  };

  const finish = async () => {
    const video = page.video();
    await context.close();
    await video.saveAs(path.join(ARTIFACTS, "videos", `${name}.webm`));
    await video.delete();
  };

  return { page, shot, finish };
}

async function login(page) {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await pause(page, 1000);
  await page.getByLabel("Username or email").pressSequentially(ADMIN_CREDENTIALS.username, { delay: 60 });
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({
    timeout: 20_000,
  });
}

/** Wait for the charts to draw rather than for a fixed time. */
async function settled(page) {
  await dataDrawn(page).catch(() => {});
  await pause(page);
}

async function tourPages(page, shot) {
  await page.getByRole("button", { name: "30 days" }).click();
  await settled(page);
  await shot("dashboard");
  await page.mouse.wheel(0, 700);
  await pause(page);
  await shot("dashboard-charts");

  await page.getByRole("link", { name: "Analytics", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Analytics", level: 5 })).toBeVisible();
  for (const tab of ["Per camera", "Weekday by zone", "Ratio trends", "By location", "Peak hours"]) {
    await page.getByRole("tab", { name: tab }).click();
    await settled(page);
    await shot(`analytics-${tab.toLowerCase().replace(/\s+/g, "-")}`);
  }
  // The location cascade: one building narrows every chart.
  await page.getByLabel("Building").click();
  await page.getByRole("option", { name: "Mall A" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "By location" }).click();
  await settled(page);
  await shot("analytics-mall-a");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "30 days" }).click();

  await page.getByRole("link", { name: "Visits", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Dwell" })).toBeVisible({ timeout: 20_000 });
  await pause(page);
  await shot("visits");
  await page.getByLabel("Gender", { exact: true }).click();
  await page.getByRole("option", { name: "Female" }).click();
  await settled(page);
  await shot("visits-female");

  await page.getByRole("link", { name: "Snapshots", exact: true }).click();
  await expect(page.getByText(/snapshot\(s\)$/)).toBeVisible({ timeout: 20_000 });
  await settled(page);
  await shot("snapshots");
  const frame = page.locator("img[src*='/snapshots/']").first();
  // count() does not wait, and the grid renders its images after the counts.
  await frame.waitFor({ timeout: 10_000 }).catch(() => {});
  if (await frame.count()) {
    await frame.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await pause(page);
    await shot("snapshot-frame");
    await page.keyboard.press("Escape");
  }

  await page.getByRole("link", { name: "Cameras", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cameras", level: 5 })).toBeVisible();
  await pause(page);
  await shot("cameras");
  await page.getByRole("link", { name: SEED.cameraName }).click();
  const live = page.getByRole("img", { name: `Live view from ${SEED.cameraName}` });
  await expect
    .poll(() => live.evaluate((img) => img.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);
  // Let the live view run: people walk through and their labels settle.
  await pause(page, 8000);
  await shot("camera-live");
  await page.mouse.wheel(0, 700);
  await pause(page, 3000);
  await shot("camera-people");

  for (const [label, heading] of [
    ["Workers & config", "Workers & config"],
    ["Workspaces", "Workspaces"],
    ["Users", "Users"],
  ]) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, level: 5 })).toBeVisible();
    await settled(page);
    await shot(label.toLowerCase().replace(/\W+/g, "-"));
  }
}

test("desktop tour, dark mode", async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, shot, finish } = await startTour(browser, "01-desktop-dark");
  try {
    await login(page);
    await tourPages(page, shot);
  } finally {
    await finish();
  }
});

test("desktop tour, light mode", async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, shot, finish } = await startTour(browser, "02-desktop-light", { mode: "light" });
  try {
    await page.goto("/login");
    await shot("login");
    await login(page);
    await tourPages(page, shot);
  } finally {
    await finish();
  }
});

test("phone tour", async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, shot, finish } = await startTour(browser, "03-phone", {
    viewport: PHONE,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await login(page);
    await settled(page);
    await shot("dashboard");

    for (const [label, heading] of [
      ["Analytics", "Analytics"],
      ["Visits", "Visits"],
      ["Snapshots", "Snapshots"],
      ["Cameras", "Cameras"],
    ]) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await pause(page, 800);
      if (label === "Analytics") await shot("menu");
      await page.getByRole("link", { name: label, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, level: 5 })).toBeVisible();
      await settled(page);
      await shot(label.toLowerCase());
      // Scroll through, so the video shows the whole page.
      await page.mouse.wheel(0, 1200);
      await pause(page, 1200);
    }

    await page.getByRole("link", { name: SEED.cameraName }).first().click();
    const live = page.getByRole("img", { name: `Live view from ${SEED.cameraName}` });
    await expect
      .poll(() => live.evaluate((img) => img.naturalWidth), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await pause(page, 6000);
    await shot("camera-live");
  } finally {
    await finish();
  }
});
