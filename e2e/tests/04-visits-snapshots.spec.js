import { expect, test } from "@playwright/test";
import { API, SEED, authHeaders, collectPageProblems } from "./helpers.js";

/** The rows behind the charts: the Visits table and its CSV, and the Snapshots grid. */
test.describe.configure({ mode: "serial" });

test("visits filter by gender and page", async ({ request }) => {
  const params = { camera_ids: SEED.cameraId, gender: "female", limit: 5 };
  const response = await request.get(`${API}/visits`, { headers: authHeaders(), params });
  const body = (await response.json()).data;
  expect(body.total).toBeGreaterThan(5);
  expect(body.items).toHaveLength(5);
  expect(body.items.every((v) => v.gender === "female" && v.camera_id === SEED.cameraId)).toBe(true);
});

test("the Visits page lists, filters and exports", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/visits");
  await expect(page.getByRole("heading", { name: "Visits", level: 5 })).toBeVisible();
  await page.getByRole("button", { name: "30 days" }).click();
  await expect(page.getByRole("columnheader", { name: "Dwell" })).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("Gender", { exact: true }).click();
  await page.getByRole("option", { name: "Child" }).click();
  const chips = page.locator("tbody").getByText(/^(Male|Female|Child|Unknown)$/);
  await expect(chips.first()).toHaveText("Child");
  expect(new Set(await chips.allTextContents())).toEqual(new Set(["Child"]));

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const csv = await (await download).path();
  const fs = await import("fs");
  const lines = fs.readFileSync(csv, "utf-8").trim().split("\n");
  expect(lines[0]).toContain("gender");
  expect(lines.slice(1).every((line) => line.includes(",child,"))).toBe(true);

  await page.screenshot({ path: "test-results/visits.png", fullPage: true });
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the Snapshots page shows counts and opens a frame", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/snapshots");
  await expect(page.getByRole("heading", { name: "Snapshots", level: 5 })).toBeVisible();
  await expect(page.getByText(/snapshot\(s\)$/)).toBeVisible({ timeout: 20_000 });

  // Spec 02's camera stored real annotated frames; the seed's have none.
  const withFrame = page.locator("img[src*='/snapshots/']").first();
  if (await withFrame.count()) {
    await withFrame.click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "Annotated frame" })).toBeVisible();
    await page.screenshot({ path: "test-results/snapshot-dialog.png" });
    await page.keyboard.press("Escape");
  }
  await page.screenshot({ path: "test-results/snapshots.png", fullPage: true });
  expect(problems, problems.join("\n")).toEqual([]);
});
