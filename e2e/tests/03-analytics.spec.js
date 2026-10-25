import { expect, test } from "@playwright/test";
import { API, SEED, authHeaders, collectPageProblems } from "./helpers.js";

/**
 * The analytics against the 14 days database/seed.sql loads: InsightEye's two
 * endpoints keep their response shapes, the extended reports add up, and every
 * Analytics tab draws its chart.
 */
test.describe.configure({ mode: "serial" });

const today = new Date().toISOString().slice(0, 10);
const twoWeeksAgo = new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10);
const RANGE = { start_date: twoWeeksAgo, end_date: today, tz: "UTC" };

async function get(request, path, params = {}) {
  const response = await request.get(`${API}${path}`, { headers: authHeaders(), params });
  expect(response.ok(), `GET ${path} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

test("average-gender keeps InsightEye's response shape", async ({ request }) => {
  const body = await get(request, "/analytics/cameras/average-gender", { ...RANGE, gender: "female" });
  expect(body).toMatchObject({ success: true, gender: "female" });
  expect(body.count).toBe(body.data.length);
  const seeded = body.data.find((row) => row.camera_id === SEED.cameraId);
  expect(seeded).toBeTruthy();
  for (const key of ["camera_name", "zone", "avg_count", "max_count", "min_count", "sample_size", "visit_count"]) {
    expect(seeded).toHaveProperty(key);
  }
  expect(seeded.sample_size).toBeGreaterThan(100);
  expect(seeded.visit_count).toBeGreaterThan(0);
});

test("gender-by-weekday covers every seeded zone", async ({ request }) => {
  const body = await get(request, "/analytics/zones/gender-by-weekday", { ...RANGE, gender: "male" });
  const zones = [...new Set(body.data.map((row) => row.zone))].sort();
  for (const zone of SEED.zones) expect(zones).toContain(zone);
  expect(body.data[0]).toHaveProperty("weekday_name");
});

test("ratio trends split each day into shares that add up", async ({ request }) => {
  const body = await get(request, "/analytics/gender/ratio-trends", { ...RANGE, interval: "day" });
  const series = body.data.series;
  expect(series.length).toBeGreaterThanOrEqual(13);
  for (const day of series) {
    const shares = day.male_pct + day.female_pct + day.child_pct;
    expect(shares).toBeGreaterThan(99.5);
    expect(shares).toBeLessThan(100.5);
  }
});

test("the location filter narrows every report", async ({ request }) => {
  const all = await get(request, "/analytics/gender/distribution-by-location", {
    ...RANGE,
    group_by: "building",
  });
  expect(all.data.groups.map((g) => g.group).sort()).toEqual(expect.arrayContaining(SEED.buildings));

  const mallB = await get(request, "/analytics/gender/distribution-by-location", {
    ...RANGE,
    group_by: "zone",
    buildings: "Mall B",
  });
  expect(mallB.data.groups.map((g) => g.group)).toEqual(["Electronics"]);
});

test("peak hours fall inside the seeded opening hours", async ({ request }) => {
  const body = await get(request, "/analytics/gender/peak-hours", RANGE);
  expect(body.data.hours).toHaveLength(24);
  for (const g of ["male", "female", "child"]) {
    expect(body.data[`peak_${g}_hour`]).toBeGreaterThanOrEqual(8);
    expect(body.data[`peak_${g}_hour`]).toBeLessThanOrEqual(21);
  }
});

test("every Analytics tab draws its chart", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics", level: 5 })).toBeVisible();
  await page.getByRole("button", { name: "30 days" }).click();

  for (const tab of ["Per camera", "Weekday by zone", "Ratio trends", "By location", "Peak hours"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Nothing in this range")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/analytics-${tab.toLowerCase().replace(/\s+/g, "-")}.png`,
      fullPage: true,
    });
  }

  // The cascade: picking a building only leaves that building's zones.
  await page.getByLabel("Building").click();
  await page.getByRole("option", { name: "Mall B" }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Zone").click();
  await expect(page.getByRole("option")).toHaveText(["Electronics"]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reset" }).click();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the dashboard shows the seeded mix", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/");
  await expect(page.getByText("Visits per day")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Men today", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
  expect(problems, problems.join("\n")).toEqual([]);
});
