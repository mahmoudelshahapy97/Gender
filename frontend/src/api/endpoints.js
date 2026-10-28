import client, { API_BASE, mediaUrl } from "./client";

/**
 * One function per backend route, so no component builds a URL by hand.
 *
 * Mirrors app/api/routes/: camera_router, analytics_router, visit_router,
 * snapshot_router, system_router and the account routers.
 */

// --- health and system ----------------------------------------------------
export const health = {
  // /health is mounted on the app root, outside the versioned prefix, so it is
  // the one call that has to escape the axios baseURL.
  live: (opts) => client.get("/health", { baseURL: "", ...opts }).then((r) => r.data),
};

// --- auth -------------------------------------------------------------------
export const auth = {
  login: (username, password) =>
    client.post("/auth/login", { username, password }).then((r) => r.data),
  refresh: (refreshToken) =>
    client.post("/auth/refresh", { refresh_token: refreshToken }).then((r) => r.data),
  logout: (refreshToken) =>
    client.post("/auth/logout", { refresh_token: refreshToken }).then((r) => r.data),
  logoutAll: () => client.post("/auth/logout-all").then((r) => r.data),
  me: (opts) => client.get("/auth/me", opts).then((r) => r.data),
  /** The account's own {full_name, notify_email}. */
  updateMe: (payload) => client.patch("/auth/me", payload).then((r) => r.data),
  changePassword: (currentPassword, newPassword) =>
    client
      .post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      })
      .then((r) => r.data),
  /** Public: what the console may offer, e.g. {password_reset, notification_email}. */
  options: (opts) => client.get("/auth/options", opts).then((r) => r.data),
  /** Mails a reset code; the answer is the same whether or not the account exists. */
  forgotPassword: (email) =>
    client.post("/auth/forgot-password", { email }).then((r) => r.data),
  resetPassword: ({ email, code, newPassword }) =>
    client
      .post("/auth/reset-password", { email, code, new_password: newPassword })
      .then((r) => r.data),
};

// --- workspaces -------------------------------------------------------------
export const workspaces = {
  /** The caller's workspaces (all of them for admins), Default first. */
  mine: (opts) => client.get("/workspaces/mine", opts).then((r) => r.data),
  // Admin only from here.
  list: (opts) => client.get("/workspaces", opts).then((r) => r.data),
  create: (payload) => client.post("/workspaces", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/workspaces/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/workspaces/${id}`).then((r) => r.data),
  members: (id, opts) => client.get(`/workspaces/${id}/members`, opts).then((r) => r.data),
};

// --- users (admin only) ------------------------------------------------------
export const users = {
  list: (opts) => client.get("/users", opts).then((r) => r.data),
  get: (id, opts) => client.get(`/users/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/users", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data),
  resetPassword: (id, newPassword) =>
    client.post(`/users/${id}/reset-password`, { new_password: newPassword }).then((r) => r.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),
};

export const system = {
  workers: (opts) => client.get("/system/workers", opts).then((r) => r.data),
  config: (opts) => client.get("/system/config", opts).then((r) => r.data),
};

// --- cameras --------------------------------------------------------------
export const cameras = {
  list: (params, opts) => client.get("/cameras", { params, ...opts }).then((r) => r.data),
  get: (id, opts) => client.get(`/cameras/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/cameras", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/cameras/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/cameras/${id}`).then((r) => r.data),

  start: (id) => client.post(`/cameras/${id}/start`).then((r) => r.data),
  stop: (id) => client.post(`/cameras/${id}/stop`).then((r) => r.data),
  status: (id, opts) => client.get(`/cameras/${id}/status`, opts).then((r) => r.data),

  /**
   * Latest frame, as an <img> source. The timestamp is not decoration: without
   * it the browser serves the frame it already has and the view never updates.
   */
  snapshotUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/snapshot`, { t: bust }),

  /**
   * MJPEG live view of the annotated detection output, as an <img> source.
   * Bump `bust` to reconnect after the worker restarts.
   */
  streamUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/stream`, { t: bust }),

  /** Open the camera's stream briefly and report what it found; detection is not touched. */
  probe: (id) => client.post(`/cameras/${id}/probe`).then((r) => r.data),
  /** The same for every enabled camera of the workspace, a few at a time. */
  probeAll: () => client.post("/cameras/probe-all").then((r) => r.data),
};

// --- notifications ----------------------------------------------------------
// Across every workspace the caller can see; {workspace_id} narrows to one.
export const notifications = {
  /** {unread_only, kind (comma-joined), workspace_id, limit, offset} -> {total, unread, items} */
  list: (params, opts) => client.get("/notifications", { params, ...opts }).then((r) => r.data.data),
  unreadCount: (opts) =>
    client.get("/notifications/unread-count", opts).then((r) => r.data.data.unread),
  /** The listed ids, or every unread one when none are given. -> {marked, unread} */
  markRead: (ids) =>
    (ids?.length
      ? client.post("/notifications/read", { notification_ids: ids })
      : client.post("/notifications/read-all", {})
    ).then((r) => r.data.data),
  markUnread: (id) => client.delete(`/notifications/${id}/read`).then((r) => r.data.data),
  /** A "system" notification to yourself, to check the bell and the stream end to end. */
  sendTest: () => client.post("/notifications/test").then((r) => r.data.data),
  /**
   * Server-Sent Events, for an EventSource: cookie-authenticated like the
   * <img> routes, since an EventSource cannot send a header either.
   */
  streamUrl: () => mediaUrl("/notifications/stream"),
};

// --- audit log ----------------------------------------------------------------
export const audit = {
  /** {action, actor, since, until, limit, offset} -> {items, total}. Admins only. */
  list: (params, opts) => client.get("/audit-logs", { params, ...opts }).then((r) => r.data),
  exportBlob: (params) =>
    client.get("/audit-logs/export.csv", { params, responseType: "blob" }).then((r) => r.data),
};

// --- analytics ------------------------------------------------------------
// Every call takes the filter bar's params: start_date, end_date, camera_ids,
// locations, areas, buildings, floor_levels, zones (comma-joined) and tz.
export const analytics = {
  /** Today's visits, the range's visits and dwell, who is in view now. */
  summary: (params, opts) =>
    client.get("/analytics/summary", { params, ...opts }).then((r) => r.data),
  /** InsightEye's per-camera average; {gender} is male | female | child. */
  averageGender: (params, opts) =>
    client.get("/analytics/cameras/average-gender", { params, ...opts }).then((r) => r.data),
  /** InsightEye's zone x weekday average; {gender}. */
  genderByWeekday: (params, opts) =>
    client.get("/analytics/zones/gender-by-weekday", { params, ...opts }).then((r) => r.data),
  /** {interval: hour|day|week|month, source: visits|occupancy} */
  ratioTrends: (params, opts) =>
    client.get("/analytics/gender/ratio-trends", { params, ...opts }).then((r) => r.data),
  /** {group_by: location|area|building|floor_level|zone} */
  byLocation: (params, opts) =>
    client
      .get("/analytics/gender/distribution-by-location", { params, ...opts })
      .then((r) => r.data),
  peakHours: (params, opts) =>
    client.get("/analytics/gender/peak-hours", { params, ...opts }).then((r) => r.data),
  /** {gender?} -> sparse [{weekday, hour, events}] of visits. */
  heatmap: (params, opts) =>
    client.get("/analytics/visits/hourly-heatmap", { params, ...opts }).then((r) => r.data),
  /** Cameras and the location values in use, for the filter bar. */
  filterOptions: (opts) => client.get("/analytics/filters/options", opts).then((r) => r.data),
};

// --- visits ---------------------------------------------------------------
export const visits = {
  /** filter params + {gender, limit, offset} -> {total, items} */
  list: (params, opts) => client.get("/visits", { params, ...opts }).then((r) => r.data),
  get: (id, opts) => client.get(`/visits/${id}`, opts).then((r) => r.data),
  /** CSV of the filtered visits, as a Blob to save. */
  exportCsv: (params) =>
    client.get("/visits/export.csv", { params, responseType: "blob" }).then((r) => r.data),
};

// --- snapshots ------------------------------------------------------------
export const snapshots = {
  /** filter params + {min_people, limit, offset} -> {total, items} */
  list: (params, opts) => client.get("/snapshots", { params, ...opts }).then((r) => r.data),
  get: (id, opts) => client.get(`/snapshots/${id}`, opts).then((r) => r.data),
  /** The annotated frame, as an <img> source (cookie-authenticated). */
  frameUrl: (id) => mediaUrl(`/snapshots/${id}/frame`),
};

export default {
  health,
  auth,
  users,
  system,
  cameras,
  analytics,
  visits,
  snapshots,
  notifications,
};
