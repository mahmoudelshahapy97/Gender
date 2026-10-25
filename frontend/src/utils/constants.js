/**
 * Mirrors the CHECK constraints in database/schema.sql (visit.gender) and
 * GENDER_CLASS_MAP in backend/.env — keep them in step.
 */

/** The labels gender.pt produces, in display order. */
export const GENDERS = ["male", "female", "child"];

/** visit.gender also allows "unknown": a person whose label never settled. */
export const VISIT_GENDERS = [...GENDERS, "unknown"];

export const GENDER_LABEL = {
  male: "Male",
  female: "Female",
  child: "Child",
  unknown: "Unknown",
};

/**
 * One colour per label, used by every chart, chip and stat card so a series
 * reads the same everywhere. The annotated frames use the same hues
 * (GENDER_COLORS in backend/app/utils/image_utils.py).
 */
export const GENDER_COLOR = {
  male: "#3b82f6",
  female: "#d946ef",
  child: "#f59e0b",
  unknown: "#94a3b8",
};

/** The five location levels a camera carries, coarse to fine (InsightEye's order). */
export const LOCATION_LEVELS = [
  { key: "locations", column: "location", label: "Location" },
  { key: "areas", column: "area", label: "Area" },
  { key: "buildings", column: "building", label: "Building" },
  { key: "floor_levels", column: "floor_level", label: "Floor" },
  { key: "zones", column: "zone", label: "Zone" },
];

/** A camera's place as one line, coarse to fine: "Cairo HQ › North Wing › …". */
export const placeOf = (camera) =>
  LOCATION_LEVELS.map((level) => camera[level.column])
    .filter(Boolean)
    .join(" › ");

export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 5000;

/** Default page size for the Visits table. */
export const PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * notification.kind (database/schema.sql), and how each one reads. The
 * severities are the API's: critical (a camera offline), warning (an occupancy
 * alert), info (a camera back online).
 */
export const NOTIFICATION_KINDS = ["occupancy_high", "occupancy_low", "camera_offline", "camera_online"];

export const NOTIFICATION_KIND_LABEL = {
  occupancy_high: "Crowding",
  occupancy_low: "Low occupancy",
  camera_offline: "Camera offline",
  camera_online: "Back online",
};

/** MUI palette key per severity, for icons, chips and toasts. */
export const SEVERITY_COLOR = { critical: "error", warning: "warning", info: "success" };
