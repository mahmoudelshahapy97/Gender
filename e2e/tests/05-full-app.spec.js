import { expect, test } from "@playwright/test";
import {
  API,
  CAMERA_NAME,
  OPERATOR_CREDENTIALS,
  VIEWER_CREDENTIALS,
  authHeaders,
  collectPageProblems,
  findCamera,
} from "./helpers.js";

/**
 * The rest of the console, while spec 02's camera is still counting: the
 * System page, the live view, what a viewer may do on a camera, the whole
 * account lifecycle an admin drives from the Users page, a session surviving
 * an expired access token, every page at phone width, and every page in both
 * themes. Runs before 07, which deletes the camera.
 */
test.describe.configure({ mode: "serial" });

const STAMP = Date.now();
const ACCOUNT = {
  username: `e2e-full-${STAMP}`,
  email: `e2e-full-${STAMP}@example.com`,
  password: "E2eFull!123",
};
const NEW_PASSWORD = "E2eChanged!456";

const PAGES = [
  { path: "/", heading: "Dashboard" },
  { path: "/analytics", heading: "Analytics" },
  { path: "/visits", heading: "Visits" },
  { path: "/snapshots", heading: "Snapshots" },
  { path: "/cameras", heading: "Cameras" },
  { path: "/system", heading: "Workers & config" },
  { path: "/workspaces", heading: "Workspaces" },
  { path: "/users", heading: "Users" },
];

/** A fresh browser context signed in through the login page as `creds`. */
async function signIn(browser, creds, options = {}) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, ...options });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({
    timeout: 20_000,
  });
  return { context, page };
}

async function loginStatus(request, username, password) {
  const response = await request.post(`${API}/auth/login`, { data: { username, password } });
  return response.status();
}

test("the System page lists the running worker and the configuration in force", async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.goto("/system");
  await expect(page.getByRole("heading", { name: "Workers & config", level: 5 })).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: CAMERA_NAME });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("Streaming")).toBeVisible({ timeout: 60_000 });

  await expect(page.getByText("cuda").or(page.getByText("cpu")).first()).toBeVisible();
  for (const group of ["Detection", "Counting", "Stream", "Retention", "Storage"]) {
    await expect(page.getByText(group, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("gender min votes")).toBeVisible();
  await page.screenshot({ path: "test-results/full-system.png", fullPage: true });
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the live view on the camera page streams real frames", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);
  const live = page.getByRole("img", { name: `Live view from ${CAMERA_NAME}` });
  await expect(live).toBeVisible({ timeout: 30_000 });
  // naturalWidth stays 0 until the first MJPEG part has decoded.
  await expect
    .poll(() => live.evaluate((img) => img.naturalWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test("a viewer sees a camera but cannot control or change it", async ({ browser, request }) => {
  const camera = await findCamera(request);
  const { context, page } = await signIn(browser, VIEWER_CREDENTIALS);
  try {
    await page.goto(`/cameras/${camera.camera_id}`);
    await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();
    for (const name of ["Stop worker", "Start worker", "Delete"]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);

    // And the API agrees, whatever the page shows.
    const token = await page.evaluate(() => localStorage.getItem("gender:access-token"));
    const stop = await request.post(`${API}/cameras/${camera.camera_id}/stop`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stop.status()).toBe(403);
  } finally {
    await context.close();
  }
});

test("an admin creates an account and edits its role from the Users page", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/users");
  await page.getByRole("button", { name: "New account" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username").fill(ACCOUNT.username);
  await dialog.getByLabel("Email").fill(ACCOUNT.email);
  await dialog.getByLabel("Password").fill(ACCOUNT.password);
  await dialog.getByLabel("Role").click();
  await page.getByRole("option", { name: "operator" }).click();
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  const row = page.getByRole("row").filter({ hasText: ACCOUNT.username });
  await expect(row.getByText("operator", { exact: true })).toBeVisible();
  // No workspace picked: a new account joins Default.
  await expect(row.getByText("Default")).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  await expect(dialog.getByLabel("Username")).toHaveValue(ACCOUNT.username);
  await dialog.getByLabel("Role").click();
  await page.getByRole("option", { name: "viewer" }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(row.getByText("viewer", { exact: true })).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("a password reset by an admin hands over a working temporary password", async ({
  page,
  browser,
}) => {
  await page.goto("/users");
  const row = page.getByRole("row").filter({ hasText: ACCOUNT.username });
  await row.getByRole("button", { name: "Reset password" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset password" }).click();

  const toast = page.getByText(/reset to: /);
  await expect(toast).toBeVisible({ timeout: 20_000 });
  const temporary = (await toast.textContent()).match(/reset to: (\S+)/)[1];

  const { context } = await signIn(browser, { username: ACCOUNT.username, password: temporary });
  await context.close();
  ACCOUNT.password = temporary;
});

test("a user changes their own password from the account menu", async ({ browser, request }) => {
  const { context, page } = await signIn(browser, ACCOUNT);
  try {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Change password" }).click();
    const dialog = page.getByRole("dialog");

    // A wrong current password is refused in the dialog, not silently.
    await dialog.getByLabel("Current password").fill("Wrong!12345");
    await dialog.getByLabel("New password").fill(NEW_PASSWORD);
    await dialog.getByRole("button", { name: "Change password" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();

    await dialog.getByLabel("Current password").fill(ACCOUNT.password);
    await dialog.getByRole("button", { name: "Change password" }).click();
    // Changing it signs the account out everywhere, this tab included.
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  } finally {
    await context.close();
  }

  expect(await loginStatus(request, ACCOUNT.username, ACCOUNT.password)).toBe(401);
  expect(await loginStatus(request, ACCOUNT.username, NEW_PASSWORD)).toBe(200);
  ACCOUNT.password = NEW_PASSWORD;
});

test("a deactivated account cannot sign in, and a deleted one is gone", async ({
  page,
  request,
}) => {
  await page.goto("/users");
  const row = page.getByRole("row").filter({ hasText: ACCOUNT.username });
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).not.toBeChecked({ timeout: 20_000 });
  expect(await loginStatus(request, ACCOUNT.username, ACCOUNT.password)).not.toBe(200);

  await row.getByLabel("Delete").getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });

  const users = await (await request.get(`${API}/users`, { headers: authHeaders() })).json();
  expect(users.some((user) => user.username === ACCOUNT.username)).toBe(false);
});

test("an expired access token is refreshed without the user noticing", async ({ browser }) => {
  // A session of its own, so rotating its refresh token cannot touch the
  // admin session every other spec borrows.
  const { context, page } = await signIn(browser, OPERATOR_CREDENTIALS);
  try {
    const problems = collectPageProblems(page);
    await page.evaluate(() => localStorage.setItem("gender:access-token", "expired.not.valid"));
    await page.goto("/visits");
    await expect(page.getByRole("heading", { name: "Visits", level: 5 })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Dwell" })).toBeVisible({
      timeout: 20_000,
    });
    const token = await page.evaluate(() => localStorage.getItem("gender:access-token"));
    expect(token).not.toBe("expired.not.valid");
    // The browser logs the 401 that triggered the refresh; nothing else.
    expect(problems.filter((p) => !/401/.test(p)), problems.join("\n")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("every page fits a phone screen, and the menu reaches them", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: ".auth/admin.json",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const problems = collectPageProblems(page);
  try {
    for (const { path, heading } of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, level: 5 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/mobile${path === "/" ? "-dashboard" : path.replace("/", "-")}.png`,
        fullPage: true,
      });
    }

    // Paging has to stay reachable: the next-page arrow once sat off the edge.
    await page.goto("/visits");
    await expect(page.getByText(/^1–20 of /)).toBeVisible({ timeout: 20_000 });
    const next = page.getByRole("button", { name: "Go to next page" });
    // Below the fold is fine; past the right edge is not. Scroll down only,
    // since scrolling it into view would also scroll the paginator sideways.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const box = await next.boundingBox();
    expect(box.x + box.width, "next-page arrow sits past the right edge").toBeLessThanOrEqual(390);
    await next.click();
    await expect(page.getByText(/^21–40 of /)).toBeVisible();

    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: "Snapshots", exact: true }).click();
    await expect(page).toHaveURL(/\/snapshots$/);
    await expect(page.getByRole("heading", { name: "Snapshots", level: 5 })).toBeVisible();
    expect(problems, problems.join("\n")).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const mode of ["light", "dark"]) {
  test(`every page renders cleanly in ${mode} mode`, async ({ page }) => {
    await page.addInitScript((m) => localStorage.setItem("gender:color-mode", m), mode);
    const problems = collectPageProblems(page);
    for (const { path, heading } of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, level: 5 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.screenshot({
        path: `test-results/${mode}${path === "/" ? "-dashboard" : path.replace("/", "-")}.png`,
        fullPage: true,
      });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
