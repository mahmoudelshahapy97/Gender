import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid2";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";

import { errorMessage } from "../../api/client";
import { cameras as camerasApi } from "../../api/endpoints";
import { useAsync } from "../../hooks/useAsync";
import { useToast } from "../../components/Toast";
import { ErrorState, Loading } from "../../components/DataStates";
import PageHeader from "../../components/PageHeader";
import { parseJsonField } from "../../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

/** InsightEye's location hierarchy, coarse to fine: what the analytics filter and group by. */
const LOCATION_FIELDS = [
  { key: "location", get label() { return i18n.t("cameraForm.location"); }, get placeholder() { return i18n.t("cameraForm.phLocation"); } },
  { key: "area", get label() { return i18n.t("cameraForm.area"); }, get placeholder() { return i18n.t("cameraForm.phArea"); } },
  { key: "building", get label() { return i18n.t("cameraForm.building"); }, placeholder: "B1" },
  { key: "floor_level", get label() { return i18n.t("cameraForm.floor"); }, get placeholder() { return i18n.t("cameraForm.phFloor"); } },
  { key: "zone", get label() { return i18n.t("cameraForm.zone"); }, get placeholder() { return i18n.t("cameraForm.phZone"); } },
];

/**
 * The counting knobs a camera may override (CountingParams and the worker's
 * own two). They live in the `settings` jsonb rather than in columns of their
 * own, so an absent key means "inherit the global .env value" — a different
 * thing from 0, which is why blanks are omitted from the payload rather than
 * sent as zero.
 */
const OVERRIDE_FIELDS = [
  {
    key: "snapshot_interval_s",
    get label() { return i18n.t("cameraForm.snapshotEvery"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.howOftenOccupancyAndIts"); },
    min: 5,
    max: 3600,
  },
  {
    key: "gender_every_n",
    get label() { return i18n.t("cameraForm.genderModelEvery"); },
    unit: "frames",
    get help() { return i18n.t("cameraForm.genderPtRunsOnEvery"); },
    min: 1,
    max: 100,
  },
  {
    key: "min_votes",
    get label() { return i18n.t("cameraForm.votesToSettleALabel"); },
    unit: "votes",
    get help() { return i18n.t("cameraForm.aPersonStaysUnknownUntil"); },
    min: 1,
    max: 50,
  },
  {
    key: "visit_gap_seconds",
    get label() { return i18n.t("cameraForm.visitEndsAfter"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.aPersonUnseenThisLong"); },
    min: 1,
    max: 600,
  },
];

/**
 * Occupancy alerts (backend/app/services/alerts.py). Also in `settings`, and
 * also blank = off; a count past one for ALERT_SUSTAIN_S raises one
 * notification per crossing.
 */
const ALERT_FIELDS = [
  {
    key: "alert_max_people",
    get label() { return i18n.t("cameraForm.alertAbove"); },
    get help() { return i18n.t("cameraForm.notifyWhenMorePeopleThan"); },
  },
  {
    key: "alert_min_people",
    get label() { return i18n.t("cameraForm.alertBelow"); },
    get help() { return i18n.t("cameraForm.notifyWhenFewerPeopleThan"); },
  },
];

const EMPTY = {
  name: "",
  rtsp_url: "",
  enabled: true,
  ...Object.fromEntries(LOCATION_FIELDS.map(({ key }) => [key, ""])),
  ...Object.fromEntries(OVERRIDE_FIELDS.map(({ key }) => [key, ""])),
  ...Object.fromEntries(ALERT_FIELDS.map(({ key }) => [key, ""])),
};

const isBlank = (raw) => raw === "" || raw === null || raw === undefined;

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = i18n.t("cameraForm.required");
  else if (values.name.length > 120) errors.name = i18n.t("cameraForm.atMost120Characters");

  if (!values.rtsp_url.trim()) errors.rtsp_url = i18n.t("cameraForm.required");
  LOCATION_FIELDS.forEach(({ key }) => {
    if (values[key].length > 200) errors[key] = i18n.t("cameraForm.atMost200Characters");
  });

  OVERRIDE_FIELDS.forEach(({ key, min, max }) => {
    const raw = values[key];
    if (raw === "" || raw === null || raw === undefined) return;
    const value = Number(raw);
    if (Number.isNaN(value)) errors[key] = i18n.t("cameraForm.mustBeANumber");
    else if (value < min || value > max) errors[key] = i18n.t("cameraForm.betweenMinAndMax", { min, max });
  });

  ALERT_FIELDS.forEach(({ key }) => {
    const raw = values[key];
    if (isBlank(raw)) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) errors[key] = i18n.t("cameraForm.aWholeNumber0Or");
  });
  if (
    !errors.alert_max_people &&
    !errors.alert_min_people &&
    !isBlank(values.alert_max_people) &&
    !isBlank(values.alert_min_people) &&
    Number(values.alert_min_people) > Number(values.alert_max_people)
  ) {
    errors.alert_min_people = i18n.t("cameraForm.aboveTheCrowdingLimit");
  }

  return errors;
}

export default function CameraForm() {
  const { t } = useTranslation();
  const { cameraId } = useParams();
  const isEdit = Boolean(cameraId);
  const navigate = useNavigate();
  const toast = useToast();

  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const {
    data: camera,
    error: loadError,
    loading,
    refresh,
  } = useAsync(({ signal }) => camerasApi.get(cameraId, { signal }), [cameraId], {
    enabled: isEdit,
  });

  useEffect(() => {
    if (!camera) return;
    const settings = parseJsonField(camera.settings, {}) || {};
    setValues({
      name: camera.name ?? "",
      rtsp_url: camera.rtsp_url ?? "",
      enabled: camera.enabled ?? true,
      ...Object.fromEntries(LOCATION_FIELDS.map(({ key }) => [key, camera[key] ?? ""])),
      ...Object.fromEntries(OVERRIDE_FIELDS.map(({ key }) => [key, settings[key] ?? ""])),
      ...Object.fromEntries(ALERT_FIELDS.map(({ key }) => [key, settings[key] ?? ""])),
    });
  }, [camera]);

  const setField = (field) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const payload = useMemo(() => {
    const settings = {};
    [...OVERRIDE_FIELDS, ...ALERT_FIELDS].forEach(({ key }) => {
      const raw = values[key];
      // Omitted, not zeroed: an absent key is what "inherit the default" means.
      if (raw !== "" && raw !== null && raw !== undefined) settings[key] = Number(raw);
    });

    return {
      name: values.name.trim(),
      rtsp_url: values.rtsp_url.trim(),
      // null clears a level that was set before.
      ...Object.fromEntries(LOCATION_FIELDS.map(({ key }) => [key, values[key].trim() || null])),
      enabled: values.enabled,
      settings,
    };
  }, [values]);

  const submit = async (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setSubmitError(null);
    try {
      if (isEdit) {
        await camerasApi.update(cameraId, payload);
        toast.success(t("cameraForm.cameraNameUpdated", { name: payload.name }));
        navigate(`/cameras/${cameraId}`);
      } else {
        const created = await camerasApi.create(payload);
        toast.success(t("cameraForm.cameraNameRegistered", { name: created.name }));
        navigate(`/cameras/${created.camera_id}`);
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && loading && !camera) return <Loading label={t("cameraForm.loadingCamera")} />;
  if (isEdit && loadError) return <ErrorState error={loadError} onRetry={refresh} />;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
        sx={{ mb: 2 }}
      >
        {t("cameraForm.back")}
      </Button>

      <PageHeader
        title={isEdit ? t("cameraForm.editV0", { v0: camera?.name || "camera" }) : t("cameraForm.registerACamera")}
        subtitle={
          isEdit
            ? t("cameraForm.aRunningWorkerIsRestarted")
            : t("cameraForm.anEnabledCameraStartsCounting")
        }
      />

      <Box component="form" onSubmit={submit} noValidate>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                  {t("cameraForm.source")}
                </Typography>
                <Stack spacing={2.5}>
                  <TextField
                    label={t("cameraForm.name")}
                    value={values.name}
                    onChange={setField("name")}
                    error={Boolean(errors.name)}
                    helperText={errors.name || t("cameraForm.mustBeUniqueWithinThis")}
                    required
                    fullWidth
                    autoFocus
                  />
                  <TextField
                    label={t("cameraForm.rtspUrl")}
                    value={values.rtsp_url}
                    onChange={setField("rtsp_url")}
                    error={Boolean(errors.rtsp_url)}
                    helperText={
                      errors.rtsp_url ||
                      t("cameraForm.rtspUserPassHost554")
                    }
                    required
                    fullWidth
                    placeholder={t("cameraForm.rtspMediamtx8554Gender")}
                  />
                  <FormControlLabel
                    control={<Switch checked={values.enabled} onChange={setField("enabled")} />}
                    label={t("cameraForm.enabled")}
                  />
                </Stack>
              </CardContent>
            </Card>
            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.place")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.theAnalyticsFilterAndGroup")}
                </Typography>
                <Grid container spacing={2}>
                  {LOCATION_FIELDS.map(({ key, label, placeholder }) => (
                    <Grid key={key} size={{ xs: 12, sm: key === "location" ? 12 : 6 }}>
                      <TextField
                        label={label}
                        value={values[key]}
                        onChange={setField(key)}
                        error={Boolean(errors[key])}
                        helperText={errors[key]}
                        placeholder={placeholder}
                        fullWidth
                      />
                    </Grid>
                  ))}
                </Grid>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.counting")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.leaveAFieldBlankTo")}
                </Typography>
                <Divider sx={{ mb: 2.5 }} />
                <Stack spacing={2.5}>
                  {OVERRIDE_FIELDS.map(({ key, label, unit, help }) => (
                    <TextField
                      key={key}
                      label={label}
                      value={values[key]}
                      onChange={setField(key)}
                      error={Boolean(errors[key])}
                      helperText={errors[key] || help}
                      type="number"
                      fullWidth
                      slotProps={{
                        input: {
                          endAdornment: <InputAdornment position="end">{unit}</InputAdornment>,
                        },
                      }}
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.alerts")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.everyoneWhoCanSeeThis")}
                </Typography>
                <Divider sx={{ mb: 2.5 }} />
                <Stack spacing={2.5}>
                  {ALERT_FIELDS.map(({ key, label, help }) => (
                    <TextField
                      key={key}
                      label={label}
                      value={values[key]}
                      onChange={setField(key)}
                      error={Boolean(errors[key])}
                      helperText={errors[key] || help}
                      type="number"
                      fullWidth
                      slotProps={{
                        htmlInput: { min: 0, step: 1 },
                        input: {
                          endAdornment: <InputAdornment position="end">{t("cameraForm.people")}</InputAdornment>,
                        },
                      }}
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={12}>
            {submitError ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {submitError}
              </Alert>
            ) : null}
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving ? t("cameraForm.saving") : isEdit ? t("cameraForm.saveChanges") : t("cameraForm.registerCamera")}
              </Button>
              <Button
                color="inherit"
                disabled={saving}
                onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
              >
                {t("cameraForm.cancel")}
              </Button>
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </Box>
  );
}
