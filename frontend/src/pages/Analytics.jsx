import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid2";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";

import { Bar, Line } from "react-chartjs-2";
import dayjs from "dayjs";

import { analytics } from "../api/endpoints";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import GenderFilterBar from "../components/GenderFilterBar";
import HourHeatmap from "../components/HourHeatmap";
import PageHeader from "../components/PageHeader";
import { useAsync } from "../hooks/useAsync";
import { useFilters } from "../hooks/useFilters";
import { barStyle, lineStyle, useBaseOptions } from "../utils/charts";
import { GENDERS, GENDER_COLOR, GENDER_LABEL, LOCATION_LEVELS } from "../utils/constants";
import { formatDuration, formatNumber } from "../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const TABS = [
  { key: "camera", get label() { return i18n.t("analytics.perCamera"); } },
  { key: "weekday", get label() { return i18n.t("analytics.weekdayByZone"); } },
  { key: "trends", get label() { return i18n.t("analytics.ratioTrends"); } },
  { key: "location", get label() { return i18n.t("analytics.byLocation"); } },
  { key: "hours", get label() { return i18n.t("analytics.peakHours"); } },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Zone series. Kept clear of GENDER_COLOR's blue / fuchsia / amber, so a zone
// is never read as a gender.
const PALETTE = ["#14b8a6", "#8b5cf6", "#f43f5e", "#84cc16", "#0891b2", "#a16207"];

const pct = (value) => (value === null || value === undefined ? "—" : `${Number(value).toFixed(1)}%`);

function ChartCard({ title, subtitle, height = 340, action, children }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
          <Box>
            <Typography variant="subtitle2">{title}</Typography>
            {subtitle && (
              <Typography variant="caption" color="text.secondary">
                {subtitle}
              </Typography>
            )}
          </Box>
          {action}
        </Stack>
        <Box sx={{ mt: 2, height }}>{children}</Box>
      </CardContent>
    </Card>
  );
}

function GenderToggle({ value, onChange, allowAll = false }) {
  const { t } = useTranslation();
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value}
      onChange={(_, next) => next !== null && onChange(next)}
    >
      {allowAll && <ToggleButton value="all">{t("analytics.all")}</ToggleButton>}
      {GENDERS.map((g) => (
        <ToggleButton key={g} value={g} sx={{ "&.Mui-selected": { color: GENDER_COLOR[g] } }}>
          {GENDER_LABEL[g]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/** Wraps a request: loading, error and empty states in one place. */
function Chart({ request, empty, children }) {
  const { t } = useTranslation();
  if (request.loading && !request.data) return <Loading height="100%" />;
  if (request.error) return <ErrorState error={request.error} onRetry={request.refresh} />;
  if (empty) return <EmptyState title={t("analytics.nothingInThisRange")} description={t("analytics.widenTheDatesOrThe")} />;
  return children;
}

// --------------------------------------------------- InsightEye: per camera
function PerCamera({ params, paramsKey, theme }) {
  const { t } = useTranslation();
  const base = useBaseOptions(theme);
  // All three genders at once, so the chart compares them side by side - the
  // InsightEye Average Male / Average Female charts, merged.
  const request = useAsync(
    async ({ signal }) => {
      const [male, female, child] = await Promise.all(
        GENDERS.map((gender) => analytics.averageGender({ ...params, gender }, { signal }))
      );
      return { male: male.data, female: female.data, child: child.data };
    },
    [paramsKey]
  );
  const rows = request.data?.male || [];

  const chart = useMemo(() => {
    const byCamera = (gender) =>
      Object.fromEntries((request.data?.[gender] || []).map((r) => [r.camera_id, r]));
    const lookup = Object.fromEntries(GENDERS.map((g) => [g, byCamera(g)]));
    return {
      labels: rows.map((r) => r.camera_name),
      datasets: GENDERS.map((g) => ({
        label: GENDER_LABEL[g],
        data: rows.map((r) => lookup[g][r.camera_id]?.avg_count ?? 0),
        backgroundColor: GENDER_COLOR[g],
        ...barStyle(theme),
      })),
    };
  }, [request.data, rows, theme]);

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <ChartCard
          title={t("analytics.averagePeopleInViewPer")}
          subtitle={t("analytics.insighteyeSAverageMaleFemale")}
        >
          <Chart request={request} empty={!rows.length}>
            <Bar data={chart} options={base} />
          </Chart>
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <Card>
          <TableContainer>
            <Table size="small" sx={{ "& th, & td": { px: 1.5 } }}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("analytics.camera")}</TableCell>
                  <TableCell>{t("analytics.zone")}</TableCell>
                  {GENDERS.map((g) => (
                    <TableCell key={g} align="right">
                      {t("analytics.v0AvgMax", { v0: GENDER_LABEL[g] })}
                    </TableCell>
                  ))}
                  {GENDERS.map((g) => (
                    <TableCell key={`v-${g}`} align="right">
                      {t("analytics.v0Visits", { v0: GENDER_LABEL[g] })}
                    </TableCell>
                  ))}
                  <TableCell align="right">{t("analytics.snapshots")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.camera_id} hover>
                    <TableCell>{row.camera_name}</TableCell>
                    <TableCell>{row.zone || "—"}</TableCell>
                    {GENDERS.map((g) => {
                      const r = (request.data?.[g] || []).find((x) => x.camera_id === row.camera_id);
                      return (
                        <TableCell key={g} align="right">
                          {r ? `${formatNumber(r.avg_count, 2)} / ${r.max_count}` : "—"}
                        </TableCell>
                      );
                    })}
                    {GENDERS.map((g) => {
                      const r = (request.data?.[g] || []).find((x) => x.camera_id === row.camera_id);
                      return (
                        <TableCell key={`v-${g}`} align="right">
                          {formatNumber(r?.visit_count ?? 0)}
                        </TableCell>
                      );
                    })}
                    <TableCell align="right">{formatNumber(row.sample_size)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
    </Grid>
  );
}

// ---------------------------------------------- InsightEye: weekday by zone
function WeekdayByZone({ params, paramsKey, theme }) {
  const { t } = useTranslation();
  const [gender, setGender] = useState("male");
  const base = useBaseOptions(theme);
  const request = useAsync(
    ({ signal }) => analytics.genderByWeekday({ ...params, gender }, { signal }),
    [paramsKey, gender]
  );
  const rows = request.data?.data || [];

  const chart = useMemo(() => {
    const zones = [...new Set(rows.map((r) => r.zone))];
    return {
      labels: WEEKDAYS,
      datasets: zones.map((zone, i) => ({
        label: zone,
        data: WEEKDAYS.map((day) => rows.find((r) => r.zone === zone && r.weekday_name === day)?.avg_count ?? 0),
        backgroundColor: PALETTE[i % PALETTE.length],
        ...barStyle(theme),
      })),
    };
  }, [rows, theme]);

  return (
    <ChartCard
      title={t("analytics.averageV0InViewBy", { v0: GENDER_LABEL[gender].toLowerCase() })}
      subtitle={t("analytics.insighteyeSAverageMaleFemale2")}
      height={380}
      action={<GenderToggle value={gender} onChange={setGender} />}
    >
      <Chart request={request} empty={!rows.length}>
        <Bar data={chart} options={base} />
      </Chart>
    </ChartCard>
  );
}

// ------------------------------------------------------------ ratio trends
function RatioTrends({ params, paramsKey, theme }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState("day");
  const [source, setSource] = useState("visits");
  const base = useBaseOptions(theme, { integer: source === "visits" });
  const request = useAsync(
    ({ signal }) => analytics.ratioTrends({ ...params, interval: period, source }, { signal }),
    [paramsKey, period, source]
  );
  const series = request.data?.data?.series || [];
  const fmt = { hour: "MMM D HH:00", day: "MMM D", week: "[w/c] MMM D", month: "MMM YYYY" }[period];

  const counts = useMemo(
    () => ({
      labels: series.map((p) => dayjs(p.period).format(fmt)),
      datasets: GENDERS.map((g) => ({
        label: GENDER_LABEL[g],
        data: series.map((p) => p[g]),
        ...lineStyle(theme, GENDER_COLOR[g]),
      })),
    }),
    [series, theme, fmt]
  );
  const shares = useMemo(
    () => ({
      labels: series.map((p) => dayjs(p.period).format(fmt)),
      datasets: GENDERS.map((g) => ({
        label: GENDER_LABEL[g],
        data: series.map((p) => p[`${g}_pct`] ?? 0),
        backgroundColor: GENDER_COLOR[g],
        ...barStyle(theme),
      })),
    }),
    [series, theme, fmt]
  );
  const stackedPct = useMemo(
    () => ({
      ...base,
      scales: {
        x: { ...base.scales.x, stacked: true },
        y: { ...base.scales.y, stacked: true, max: 100, ticks: { ...base.scales.y.ticks, callback: (v) => `${v}%` } },
      },
    }),
    [base]
  );

  const controls = (
    <Stack direction="row" spacing={1}>
      <TextField select size="small" value={source} onChange={(e) => setSource(e.target.value)} label={t("analytics.source")}>
        <MenuItem value="visits">{t("analytics.visitsPeople")}</MenuItem>
        <MenuItem value="occupancy">{t("analytics.occupancyAverage")}</MenuItem>
      </TextField>
      <TextField select size="small" value={period} onChange={(e) => setPeriod(e.target.value)} label={t("analytics.per")}>
        {["hour", "day", "week", "month"].map((i) => (
          <MenuItem key={i} value={i}>
            {i}
          </MenuItem>
        ))}
      </TextField>
    </Stack>
  );

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <ChartCard
          title={source === "visits" ? t("analytics.visitsByGender") : t("analytics.averagePeopleInViewBy")}
          subtitle={t("analytics.unlabelledPeopleAreLeftOut")}
          action={controls}
        >
          <Chart request={request} empty={!series.length}>
            <Line data={counts} options={base} />
          </Chart>
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <ChartCard title={t("analytics.shareOfEachGender")} subtitle={t("analytics.ofTheLabelledPeoplePer")} height={260}>
          <Chart request={request} empty={!series.length}>
            <Bar data={shares} options={stackedPct} />
          </Chart>
        </ChartCard>
      </Grid>
    </Grid>
  );
}

// ---------------------------------------------------------- by location
function ByLocation({ params, paramsKey, theme }) {
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState("zone");
  const base = useBaseOptions(theme, { stacked: true, integer: true });
  const request = useAsync(
    ({ signal }) => analytics.byLocation({ ...params, group_by: groupBy }, { signal }),
    [paramsKey, groupBy]
  );
  const groups = request.data?.data?.groups || [];

  const chart = useMemo(
    () => ({
      labels: groups.map((g) => g.group),
      datasets: [...GENDERS, "unknown"].map((g) => ({
        label: GENDER_LABEL[g],
        data: groups.map((row) => row.visits?.[g] ?? 0),
        backgroundColor: GENDER_COLOR[g],
        ...barStyle(theme),
      })),
    }),
    [groups, theme]
  );

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <ChartCard
          title={t("analytics.visitsByGenderPerPlace")}
          action={
            <TextField select size="small" label={t("analytics.groupBy")} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {LOCATION_LEVELS.map((level) => (
                <MenuItem key={level.column} value={level.column}>
                  {level.label}
                </MenuItem>
              ))}
            </TextField>
          }
        >
          <Chart request={request} empty={!groups.length}>
            <Bar data={chart} options={base} />
          </Chart>
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <Card>
          <TableContainer>
            <Table size="small" sx={{ "& th, & td": { px: 1.5 } }}>
              <TableHead>
                <TableRow>
                  <TableCell>{LOCATION_LEVELS.find((l) => l.column === groupBy)?.label}</TableCell>
                  <TableCell align="right">{t("analytics.visits")}</TableCell>
                  {GENDERS.map((g) => (
                    <TableCell key={g} align="right">
                      {GENDER_LABEL[g]} %
                    </TableCell>
                  ))}
                  <TableCell align="right">{t("analytics.avgDwell")}</TableCell>
                  {GENDERS.map((g) => (
                    <TableCell key={`o-${g}`} align="right">
                      {t("analytics.avgV0InView", { v0: GENDER_LABEL[g].toLowerCase() })}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.map((row) => (
                  <TableRow key={row.group} hover>
                    <TableCell>{row.group}</TableCell>
                    <TableCell align="right">{formatNumber(row.visits?.total ?? 0)}</TableCell>
                    {GENDERS.map((g) => (
                      <TableCell key={g} align="right">
                        {pct(row.visits?.[`${g}_pct`])}
                      </TableCell>
                    ))}
                    <TableCell align="right">{formatDuration(row.avg_dwell_s)}</TableCell>
                    {GENDERS.map((g) => (
                      <TableCell key={`o-${g}`} align="right">
                        {row.occupancy ? formatNumber(row.occupancy[g], 2) : "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
    </Grid>
  );
}

// ------------------------------------------------------------ peak hours
function PeakHours({ params, paramsKey, theme }) {
  const { t } = useTranslation();
  const [gender, setGender] = useState("all");
  const base = useBaseOptions(theme, { integer: true });
  const peaks = useAsync(({ signal }) => analytics.peakHours(params, { signal }), [paramsKey]);
  const heat = useAsync(
    ({ signal }) =>
      analytics.heatmap({ ...params, gender: gender === "all" ? undefined : gender }, { signal }),
    [paramsKey, gender]
  );
  const hours = peaks.data?.data?.hours || [];
  const anyVisits = hours.some((h) => h.visits_total);

  const chart = useMemo(
    () => ({
      labels: hours.map((h) => `${String(h.hour).padStart(2, "0")}:00`),
      datasets: GENDERS.map((g) => ({
        label: GENDER_LABEL[g],
        data: hours.map((h) => h[`visits_${g}`]),
        backgroundColor: GENDER_COLOR[g],
        ...barStyle(theme),
      })),
    }),
    [hours, theme]
  );

  const peakLabel = (hour) => (hour === null || hour === undefined ? "—" : `${String(hour).padStart(2, "0")}:00`);

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          {GENDERS.map((g) => (
            <Card key={g} sx={{ flex: "1 1 180px" }}>
              <CardContent>
                <Typography variant="overline" color="text.secondary">
                  {t("analytics.busiestHourV0", { v0: GENDER_LABEL[g].toLowerCase() })}
                </Typography>
                <Typography variant="h5" sx={{ color: GENDER_COLOR[g] }}>
                  {peakLabel(peaks.data?.data?.[`peak_${g}_hour`])}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Stack>
      </Grid>
      <Grid size={12}>
        <ChartCard title={t("analytics.visitsByHourOfDay")} subtitle={t("analytics.whenEachPersonWasFirst")}>
          <Chart request={peaks} empty={!anyVisits}>
            <Bar data={chart} options={base} />
          </Chart>
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <ChartCard
          title={t("analytics.visitsByWeekdayAndHour")}
          height="auto"
          action={<GenderToggle value={gender} onChange={setGender} allowAll />}
        >
          <Chart request={heat} empty={!(heat.data?.data?.cells || []).length}>
            <HourHeatmap cells={heat.data?.data?.cells || []} unit="visit" />
          </Chart>
        </ChartCard>
      </Grid>
    </Grid>
  );
}

export default function Analytics() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [tab, setTab] = useState("camera");
  const { filters, setFilters, reset, params, paramsKey } = useFilters();
  const props = { params, paramsKey, theme };

  return (
    <Box>
      <PageHeader
        title={t("analytics.analytics")}
        subtitle={t("analytics.genderOverTimePlaceAnd")}
      />
      <GenderFilterBar filters={filters} setFilters={setFilters} reset={reset} />

      <Tabs
        value={tab}
        onChange={(_, next) => setTab(next)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ mb: 2 }}
      >
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>

      {tab === "camera" && <PerCamera {...props} />}
      {tab === "weekday" && <WeekdayByZone {...props} />}
      {tab === "trends" && <RatioTrends {...props} />}
      {tab === "location" && <ByLocation {...props} />}
      {tab === "hours" && <PeakHours {...props} />}
    </Box>
  );
}
