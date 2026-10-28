import { useCallback, useMemo, useState } from "react";
import dayjs from "dayjs";
import { LOCATION_LEVELS } from "../utils/constants";
import i18n from "i18next";

// Days and hours are cut in the viewer's zone, so "busiest hour" means theirs.
export const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const STORAGE_KEY = "gender:filters";

export const RANGE_PRESETS = [
  { key: "today", get label() { return i18n.t("useFilters.today"); }, days: 1 },
  { key: "7d", get label() { return i18n.t("useFilters.7Days"); }, days: 7 },
  { key: "30d", get label() { return i18n.t("useFilters.30Days"); }, days: 30 },
  { key: "90d", get label() { return i18n.t("useFilters.90Days"); }, days: 90 },
];

export function presetRange(days) {
  return {
    start_date: dayjs().subtract(days - 1, "day").format("YYYY-MM-DD"),
    end_date: dayjs().format("YYYY-MM-DD"),
  };
}

const EMPTY = {
  ...presetRange(7),
  camera_ids: [],
  ...Object.fromEntries(LOCATION_LEVELS.map((level) => [level.key, []])),
};

function readStored() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    return stored ? { ...EMPTY, ...stored } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * The filter bar's state, shared by Dashboard, Analytics, Visits and
 * Snapshots through sessionStorage - moving between pages keeps the range and
 * the places picked. `params` is what every API call takes: lists joined by
 * commas (InsightEye's convention), empty ones left out, plus the timezone.
 */
export function useFilters() {
  const [filters, setFiltersState] = useState(readStored);

  const setFilters = useCallback((update) => {
    setFiltersState((current) => {
      const next = typeof update === "function" ? update(current) : { ...current, ...update };
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode: the filters just do not survive navigation.
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => setFilters(EMPTY), [setFilters]);

  const params = useMemo(() => {
    const out = { tz: TIMEZONE };
    if (filters.start_date) out.start_date = filters.start_date;
    if (filters.end_date) out.end_date = filters.end_date;
    for (const key of ["camera_ids", ...LOCATION_LEVELS.map((level) => level.key)]) {
      if (filters[key]?.length) out[key] = filters[key].join(",");
    }
    return out;
  }, [filters]);

  return { filters, setFilters, reset, params, paramsKey: JSON.stringify(params) };
}

export default useFilters;
