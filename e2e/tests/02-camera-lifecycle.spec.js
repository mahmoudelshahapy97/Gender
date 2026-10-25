import { expect, test } from "@playwright/test";
import {
  CAMERA_NAME,
  CAMERA_ZONE,
  CAMERA_SOURCE,
  authHeaders,
  collectPageProblems,
  findCamera,
  waitForApi,
} from "./helpers.js";

/**
 * Registering a camera through the form, what the console shows about it
 * afterwards, and the worker counting real people off the mediamtx demo stream
 * with the production people.pt and gender.pt.
 */
test.describe.configure({ mode: "serial" });

test("the form refuses to submit without the required fields", async ({ page }) => {
  await page.goto("/cameras/new");
  await expect(
    page.getByRole("heading", { name: "Register a camera", level: 5 })
  ).toBeVisible();

  await page.getByRole("button", { name: "Register camera" }).click();

  // Client-side validation, not a round trip: the API would answer 422 with a
  // message an operator cannot act on next to the field it belongs to.
  await expect(page.getByText("Required").first()).toBeVisible();
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("an out-of-range counting override is rejected", async ({ page }) => {
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill("Invalid thresholds");
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Snapshot every").fill("1");

  await page.getByRole("button", { name: "Register camera" }).click();

  // A one-second snapshot would write a frame per camera per second.
  await expect(page.getByText("Between 5 and 3600")).toBeVisible();
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("a camera registered through the form is persisted and opened", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill(CAMERA_NAME);
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Building").fill("E2E Building");
  await page.getByLabel("Zone").fill(CAMERA_ZONE);
  // Short, so the snapshot assertions below do not wait a minute each.
  await page.getByLabel("Snapshot every").fill("15");

  await page.getByRole("button", { name: "Register camera" }).click();

  // Lands on the new camera's detail page, which means the response carried the
  // generated camera_id back.
  await expect(page).toHaveURL(/\/cameras\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();

  const stored = await findCamera(request);
  expect(stored, "camera was not persisted").not.toBeNull();
  expect(stored.rtsp_url).toBe(CAMERA_SOURCE);
  expect(stored.zone).toBe(CAMERA_ZONE);
  expect(stored.location).toBeNull();
  expect(stored.enabled).toBe(true);

  // settings is jsonb, which asyncpg hands back as a string. A blank override
  // must be absent rather than zero — zero is a real, and very wrong, value.
  const settings =
    typeof stored.settings === "string" ? JSON.parse(stored.settings) : stored.settings;
  expect(settings.snapshot_interval_s).toBe(15);
  expect(settings).not.toHaveProperty("min_votes");

  expect(problems, problems.join("\n")).toEqual([]);
});

test("a duplicate name is refused with the backend's message", async ({ page }) => {
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill(CAMERA_NAME);
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByRole("button", { name: "Register camera" }).click();

  // The 409 from the uniqueness constraint has to surface as a sentence, not a
  // silent failure that leaves the operator clicking again.
  await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("the new camera appears in the list with its state", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/cameras");

  const row = page.getByRole("row").filter({ hasText: CAMERA_NAME });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText("Enabled")).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the detail page shows the configuration that was saved", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);

  await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();
  await expect(page.getByText(CAMERA_SOURCE)).toBeVisible();
  await expect(page.getByText("snapshot_interval_s: 15")).toBeVisible();
  // The subtitle and the Place row both show it.
  await expect(page.getByText(`E2E Building › ${CAMERA_ZONE}`)).toHaveCount(2);
  await expect(page.getByText("Whole frame")).toBeVisible();

  // The camera was created enabled, so its worker was started on the spot.
  // The people panel either lists who it tracks or explains why it is empty
  // -- never an empty table that reads as "nothing in view".
  await expect(
    page
      .getByText(/Nobody in view|Worker is stopped/)
      .or(page.getByRole("columnheader", { name: "In view for" }))
  ).toBeVisible();
});

test("the worker can be stopped and started from the detail page", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);

  // Creating an enabled camera starts its worker immediately, so the page may
  // arrive in either state. Wait for the panel to settle first — isVisible()
  // does not wait, and on a page still rendering its loading state it would
  // report false for both buttons and skip straight past this.
  const stop = page.getByRole("button", { name: "Stop worker" });
  const start = page.getByRole("button", { name: "Start worker" });
  await expect(stop.or(start)).toBeVisible({ timeout: 45_000 });

  // Normalise to stopped, then assert the start path.
  if (await stop.isVisible()) {
    await stop.click();
    await expect(start).toBeVisible({ timeout: 45_000 });
  }

  await start.click();

  // The stream manager registers the worker before the RTSP source connects, so
  // this asserts registration — connection depends on mediamtx being up.
  await expect
    .poll(
      async () => {
        const response = await request.get("/api/v1/system/workers", { headers: authHeaders() });
        if (!response.ok()) return false;
        const body = await response.json();
        return (body.data?.workers || []).some((w) => w.camera_id === camera.camera_id);
      },
      { timeout: 60_000 }
    )
    .toBe(true);

  // And the page swaps its primary action without a reload.
  await expect(page.getByRole("button", { name: "Stop worker" })).toBeVisible({ timeout: 30_000 });
});

test("the worker counts people by gender off the demo stream", async ({ page, request }) => {
  test.setTimeout(300_000);
  const camera = await findCamera(request);

  // Both models load on the worker's first frame; on CPU that and the RTSP
  // connect take a while. Then people.pt tracks and gender.pt labels them.
  const status = await waitForApi(
    request,
    `/cameras/${camera.camera_id}/status`,
    (body) => (body.data?.people || []).some((p) => p.gender !== "unknown"),
    { timeout: 240_000, interval: 3000 }
  );
  const occupancy = status.data.occupancy;
  expect(occupancy.person_count).toBeGreaterThan(0);
  expect(
    occupancy.male_count + occupancy.female_count + occupancy.child_count + occupancy.unknown_count
  ).toBe(occupancy.person_count);

  // The first snapshot is written on the first processed frame, the next one
  // 15 s later (the camera's override): at least one, with its frame stored.
  const snapshots = await waitForApi(
    request,
    `/snapshots?camera_ids=${camera.camera_id}`,
    (body) => body.data?.total >= 2,
    { timeout: 60_000 }
  );
  const latest = snapshots.data.items[0];
  expect(latest.has_frame).toBe(true);
  const frame = await request.get(`/api/v1/snapshots/${latest.snapshot_id}/frame`, {
    headers: authHeaders(),
  });
  expect(frame.headers()["content-type"]).toBe("image/jpeg");

  // The detail page shows the people with their gender chips.
  await page.goto(`/cameras/${camera.camera_id}`);
  await expect(page.getByRole("columnheader", { name: "In view for" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/^(Male|Female|Child)$/).first()).toBeVisible();
  await page.screenshot({ path: "test-results/camera-detail-live.png", fullPage: true });
});
