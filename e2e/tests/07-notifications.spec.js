import { expect, test } from "@playwright/test";
import {
  API,
  CAMERA_NAME,
  CAMERA_SOURCE,
  authHeaders,
  collectPageProblems,
  deleteCameraIfPresent,
  findCamera,
  latestMailTo,
  waitForApi,
} from "./helpers.js";

/**
 * Notifications end to end, while spec 02's camera is still counting people
 * off the demo stream: an alert threshold set on the camera form, the crowding
 * alert it raises arriving live (toast, bell, list), opening it, read state,
 * a second camera that cannot connect reported offline and then back online,
 * and the alert mailed to an account that opted in.
 *
 * Faster with ALERT_SUSTAIN_S, CAMERA_OFFLINE_AFTER_S and
 * WORKER_SUPERVISION_INTERVAL_S turned down on the stack (see e2e/README.md);
 * the waits below also fit the defaults.
 */
test.describe.configure({ mode: "serial" });

const OFFLINE_CAMERA = "E2E Camera — dark";
const DEAD_SOURCE = "rtsp://mediamtx:8554/does-not-exist";
const CROWDING = `Crowding: ${CAMERA_NAME}`;

async function notificationsList(request, params = {}) {
  const response = await request.get(`${API}/notifications`, { headers: authHeaders(), params });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data;
}

async function readAll(request) {
  await request.post(`${API}/notifications/read-all`, { headers: authHeaders(), data: {} });
}

test.beforeAll(async ({ request }) => {
  // Start from nothing unread, so the badge below counts only this spec.
  await readAll(request);
  await deleteCameraIfPresent(request, OFFLINE_CAMERA);
});

test("the bar has a bell, and the page lists notifications", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();

  await page.getByRole("link", { name: "Notifications" }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("heading", { name: "Notifications", level: 5 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the camera form refuses a minimum above the crowding limit", async ({ page, request }) => {
  const camera = await findCamera(request);
  test.skip(!camera, "spec 02 did not leave a camera");
  await page.goto(`/cameras/${camera.camera_id}/edit`);
  await page.getByLabel("Alert above").fill("3");
  await page.getByLabel("Alert below").fill("5");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Above the crowding limit")).toBeVisible();
  await expect(page).toHaveURL(/\/edit$/);
});

test("a crowding alert set on the form arrives live, in the bell and the list", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const problems = collectPageProblems(page);
  const camera = await findCamera(request);
  test.skip(!camera, "spec 02 did not leave a camera");

  // Anyone in view is "more than 0": the demo clip always has somebody.
  await page.goto(`/cameras/${camera.camera_id}/edit`);
  await page.getByLabel("Alert above").fill("0");
  await page.getByLabel("Alert below").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/cameras/${camera.camera_id}$`));

  // No reload: the toast and the badge come down the event stream.
  await expect(page.getByRole("alert").filter({ hasText: CROWDING })).toBeVisible({ timeout: 180_000 });
  const bell = page.getByRole("button", { name: "Notifications", exact: true });
  await expect(page.getByTestId("notification-badge")).toHaveText(/\d/);

  await bell.click();
  const latest = page.getByRole("presentation").getByRole("list", { name: "Notifications" });
  const item = latest.getByRole("button").filter({ hasText: CROWDING }).first();
  await expect(item).toBeVisible();
  await expect(item).toContainText("above the limit of 0");

  const { items } = await notificationsList(request, { kind: "occupancy_high" });
  const stored = items.find((n) => n.title === CROWDING);
  expect(stored.camera_id).toBe(camera.camera_id);
  expect(stored.details.threshold).toBe(0);
  expect(stored.details.person_count).toBeGreaterThan(0);
  expect(stored.is_read).toBe(false);

  // Opening it marks it read and goes to its camera.
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/cameras/${camera.camera_id}$`));
  await expect
    .poll(async () => (await notificationsList(request, { kind: "occupancy_high" })).items[0].is_read)
    .toBe(true);
  expect(problems, problems.join("\n")).toEqual([]);
});

test("a count that stays past the limit alerts once, not every frame", async ({ request }) => {
  const before = (await notificationsList(request, { kind: "occupancy_high" })).total;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const after = (await notificationsList(request, { kind: "occupancy_high" })).total;
  expect(after - before).toBeLessThanOrEqual(1);
});

test("the list filters, toggles read state, and marks everything read", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/notifications");
  const list = page.getByRole("list", { name: "Notifications" });
  await expect(list.getByText(CROWDING).first()).toBeVisible();

  await page.getByLabel("Kind", { exact: true }).click();
  await page.getByRole("option", { name: "Camera offline" }).click();
  await expect(list.getByText(CROWDING)).toHaveCount(0);
  await page.getByLabel("Kind", { exact: true }).click();
  await page.getByRole("option", { name: "Crowding" }).click();

  const row = list.getByRole("listitem").filter({ hasText: CROWDING }).first();
  await row.getByRole("button", { name: "Mark unread" }).click();
  await expect(row.getByRole("button", { name: "Mark read" })).toBeVisible();
  await page.getByRole("button", { name: /^Unread/ }).click();
  await expect(list.getByText(CROWDING).first()).toBeVisible();

  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByText("All caught up")).toBeVisible();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  expect((await notificationsList(request)).unread).toBe(0);
  expect(problems, problems.join("\n")).toEqual([]);
});

test("an opted-in account is mailed, and a camera that cannot connect is reported offline then back online", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  const options = await (await request.get(`${API}/auth/options`)).json();
  const mail = Boolean(options.notification_email && process.env.MAILPIT_URL);

  if (mail) {
    await page.goto("/");
    await page.getByRole("button", { name: "Account menu" }).click();
    const toggle = page.getByRole("menuitem", { name: /Email me new alerts/ });
    await expect(toggle).toBeEnabled();
    if (!(await toggle.getByRole("checkbox").isChecked())) await toggle.click();
    await expect(page.getByText(/New alerts will be emailed to you/)).toBeVisible();
    await page.keyboard.press("Escape");
  }

  // Registered against a path mediamtx does not serve: the worker never connects.
  const created = await request.post(`${API}/cameras`, {
    headers: authHeaders(),
    data: { name: OFFLINE_CAMERA, rtsp_url: DEAD_SOURCE, enabled: true, zone: "E2E Dark corner" },
  });
  expect(created.status()).toBe(201);
  const camera = await created.json();

  const offline = await waitForApi(
    request,
    "/notifications?kind=camera_offline",
    (body) => body.data.items.some((n) => n.camera_id === camera.camera_id),
    { timeout: 240_000, interval: 3000 }
  );
  const reported = offline.data.items.find((n) => n.camera_id === camera.camera_id);
  expect(reported.title).toBe(`Camera offline: ${OFFLINE_CAMERA}`);
  expect(reported.severity).toBe("critical");
  expect(reported.message).toMatch(/No frames for/);

  if (mail) {
    const body = await latestMailTo(request, process.env.E2E_ADMIN_EMAIL || "admin@insighteye.local", {
      timeout: 60_000,
    });
    expect(body).toContain(`Camera offline: ${OFFLINE_CAMERA}`);
  }

  // Point it at the real stream: same camera, so its recovery is reported.
  const fixed = await request.patch(`${API}/cameras/${camera.camera_id}`, {
    headers: authHeaders(),
    data: { rtsp_url: CAMERA_SOURCE },
  });
  expect(fixed.ok()).toBeTruthy();
  const online = await waitForApi(
    request,
    "/notifications?kind=camera_online",
    (body) => body.data.items.some((n) => n.camera_id === camera.camera_id),
    { timeout: 180_000, interval: 3000 }
  );
  const back = online.data.items.find((n) => n.camera_id === camera.camera_id);
  expect(back.title).toBe(`Camera back online: ${OFFLINE_CAMERA}`);
  expect(back.severity).toBe("info");

  await page.goto("/notifications");
  await expect(page.getByText(`Camera back online: ${OFFLINE_CAMERA}`).first()).toBeVisible();
});

test.afterAll(async ({ request }) => {
  // Leave spec 02's camera as 08 expects it: running, without thresholds.
  const camera = await findCamera(request);
  if (camera) {
    const settings = typeof camera.settings === "string" ? JSON.parse(camera.settings) : camera.settings || {};
    delete settings.alert_max_people;
    delete settings.alert_min_people;
    await request.patch(`${API}/cameras/${camera.camera_id}`, {
      headers: authHeaders(),
      data: { settings },
    });
  }
  await deleteCameraIfPresent(request, OFFLINE_CAMERA);
  await request.patch(`${API}/auth/me`, { headers: authHeaders(), data: { notify_email: false } });
  await readAll(request);
});
