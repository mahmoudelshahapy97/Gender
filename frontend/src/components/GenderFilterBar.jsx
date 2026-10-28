import { useMemo } from "react";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import FilterAltOffIcon from "@mui/icons-material/FilterAltOff";

import { analytics } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { RANGE_PRESETS, presetRange } from "../hooks/useFilters";
import { LOCATION_LEVELS } from "../utils/constants";
import { useTranslation } from "react-i18next";

/**
 * Date range, cameras, and InsightEye's location cascade (location > area >
 * building > floor > zone, from Insight-eye's OrderFilter). Each level only
 * offers the values found on cameras that match the levels above it, so the
 * choices narrow as you go - the cascade InsightEye did with five requests is
 * worked out here from one camera list.
 */
export function GenderFilterBar({ filters, setFilters, reset, showLocations = true }) {
  const { t } = useTranslation();
  const options = useAsync(({ signal }) => analytics.filterOptions({ signal }), []);
  const cameraList = options.data?.data?.cameras || [];

  const choices = useMemo(() => {
    const out = {};
    let pool = cameraList;
    for (const level of LOCATION_LEVELS) {
      out[level.key] = [...new Set(pool.map((c) => c[level.column]).filter(Boolean))].sort();
      const picked = filters[level.key] || [];
      if (picked.length) pool = pool.filter((c) => picked.includes(c[level.column]));
    }
    out.cameras = pool;
    return out;
  }, [cameraList, filters]);

  const activePreset = RANGE_PRESETS.find((preset) => {
    const range = presetRange(preset.days);
    return range.start_date === filters.start_date && range.end_date === filters.end_date;
  })?.key;

  const selectedCameras = cameraList.filter((c) => filters.camera_ids.includes(c.camera_id));

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Grid container spacing={2} alignItems="center">
          <Grid size={{ xs: 12, md: "auto" }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={activePreset || null}
              onChange={(_, key) => {
                const preset = RANGE_PRESETS.find((p) => p.key === key);
                if (preset) setFilters(presetRange(preset.days));
              }}
              aria-label={t("genderFilterBar.dateRange")}
            >
              {RANGE_PRESETS.map((preset) => (
                <ToggleButton key={preset.key} value={preset.key}>
                  {preset.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Grid>
          <Grid size={{ xs: 6, md: 2 }}>
            <TextField
              label={t("genderFilterBar.from")}
              type="date"
              size="small"
              fullWidth
              value={filters.start_date || ""}
              onChange={(e) => setFilters({ start_date: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 2 }}>
            <TextField
              label={t("genderFilterBar.to")}
              type="date"
              size="small"
              fullWidth
              value={filters.end_date || ""}
              onChange={(e) => setFilters({ end_date: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Grid>
          <Grid size={{ xs: 12, md: "grow" }}>
            <Autocomplete
              multiple
              size="small"
              limitTags={2}
              options={choices.cameras || []}
              value={selectedCameras}
              getOptionLabel={(c) => c.name}
              isOptionEqualToValue={(a, b) => a.camera_id === b.camera_id}
              onChange={(_, value) => setFilters({ camera_ids: value.map((c) => c.camera_id) })}
              renderInput={(params) => <TextField {...params} label={t("genderFilterBar.cameras")} placeholder={t("genderFilterBar.all")} />}
            />
          </Grid>
          <Grid size={{ xs: 12, md: "auto" }}>
            <Button startIcon={<FilterAltOffIcon />} onClick={reset} color="inherit">
              {t("genderFilterBar.reset")}
            </Button>
          </Grid>
        </Grid>

        {showLocations && (
          <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 2 }}>
            {LOCATION_LEVELS.map((level, index) => (
              <Autocomplete
                key={level.key}
                multiple
                size="small"
                limitTags={1}
                fullWidth
                options={choices[level.key] || []}
                value={filters[level.key] || []}
                onChange={(_, value) =>
                  // Changing a level clears the finer ones, which may no longer apply.
                  setFilters((current) => ({
                    ...current,
                    [level.key]: value,
                    ...Object.fromEntries(LOCATION_LEVELS.slice(index + 1).map((l) => [l.key, []])),
                    camera_ids: [],
                  }))
                }
                renderInput={(params) => (
                  <TextField {...params} label={level.label} placeholder={t("genderFilterBar.all")} />
                )}
              />
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export default GenderFilterBar;
