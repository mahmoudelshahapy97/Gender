import { useMemo } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid2";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";

import BoyIcon from "@mui/icons-material/Boy";
import ChildCareIcon from "@mui/icons-material/ChildCare";
import GirlIcon from "@mui/icons-material/Girl";
import GroupsIcon from "@mui/icons-material/Groups";
import InsightsIcon from "@mui/icons-material/Insights";
import RefreshIcon from "@mui/icons-material/Refresh";
import TimerIcon from "@mui/icons-material/Timer";
import VideocamIcon from "@mui/icons-material/Videocam";

import { Bar } from "react-chartjs-2";
import dayjs from "dayjs";

import { analytics, snapshots } from "../api/endpoints";
import { ErrorState, EmptyState, Loading } from "../components/DataStates";
import GenderFilterBar from "../components/GenderFilterBar";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { useAsync } from "../hooks/useAsync";
import { useFilters } from "../hooks/useFilters";
import { usePolling } from "../hooks/usePolling";
import { barStyle, useBaseOptions } from "../utils/charts";
import { GENDERS, GENDER_COLOR, GENDER_LABEL, POLL_INTERVAL_MS } from "../utils/constants";
import { formatDuration, formatNumber, fromNow } from "../utils/format";
import { useTranslation } from "react-i18next";

const pct = (value) => (value === null || value === undefined ? "—" : `${value.toFixed(0)}%`);

/** A single bar split male / female / child by share. */
function MixBar({ mix }) {
  const { t } = useTranslation();
  const labelled = GENDERS.reduce((sum, g) => sum + (mix?.[g] || 0), 0);
  if (!labelled) {
    return (
      <Typography variant="caption" color="text.secondary">
        {t("dashboard.nobodyLabelledYet")}
      </Typography>
    );
  }
  return (
    <Box>
      <Box sx={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden" }}>
        {GENDERS.map((g) =>
          mix[g] ? (
            <Box key={g} sx={{ width: `${(100 * mix[g]) / labelled}%`, bgcolor: GENDER_COLOR[g] }} />
          ) : null
        )}
      </Box>
      <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
        {GENDERS.map((g) => (
          <Typography key={g} variant="caption" color="text.secondary">
            <Box component="span" sx={{ color: GENDER_COLOR[g], fontWeight: 700 }}>
              ●
            </Box>{" "}
            {GENDER_LABEL[g]} {pct(mix[`${g}_pct`])}
          </Typography>
        ))}
      </Stack>
    </Box>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { filters, setFilters, reset, params, paramsKey } = useFilters();
  const baseOptions = useBaseOptions(theme, { stacked: true, integer: true });

  // "In view now" moves every snapshot interval; poll it, gently.
  const summary = usePolling(({ signal }) => analytics.summary(params, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 6,
    deps: [paramsKey],
  });
  const trend = useAsync(
    ({ signal }) => analytics.ratioTrends({ ...params, interval: "day", source: "visits" }, { signal }),
    [paramsKey]
  );
  const latest = usePolling(
    ({ signal }) => snapshots.list({ ...params, start_date: undefined, end_date: undefined, limit: 12 }, { signal }),
    { intervalMs: POLL_INTERVAL_MS * 6, deps: [paramsKey] }
  );

  const data = summary.data?.data;
  const today = data?.today;
  const range = data?.range;
  const now = data?.occupancy_now;
  const cams = data?.cameras;

  // The newest snapshot per camera, from the latest dozen.
  const perCamera = useMemo(() => {
    const seen = new Map();
    for (const row of latest.data?.data?.items || []) {
      if (!seen.has(row.camera_id)) seen.set(row.camera_id, row);
    }
    return [...seen.values()];
  }, [latest.data]);

  const trendChart = useMemo(() => {
    const series = trend.data?.data?.series || [];
    return {
      data: {
        labels: series.map((p) => dayjs(p.period).format("MMM D")),
        datasets: [...GENDERS, "unknown"].map((g) => ({
          label: GENDER_LABEL[g],
          data: series.map((p) => p[g]),
          backgroundColor: GENDER_COLOR[g],
          ...barStyle(theme),
        })),
      },
      options: baseOptions,
    };
  }, [trend.data, theme, baseOptions]);

  const refreshAll = () => {
    summary.refresh();
    trend.refresh();
    latest.refresh();
  };

  return (
    <Box>
      <PageHeader
        title={t("dashboard.dashboard")}
        subtitle={t("dashboard.whoCameInAndWho")}
        actions={[
          <Button key="analytics" component={RouterLink} to="/analytics" startIcon={<InsightsIcon />}>
            {t("dashboard.openAnalytics")}
          </Button>,
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            {t("dashboard.refresh")}
          </Button>,
        ]}
      />

      <GenderFilterBar filters={filters} setFilters={setFilters} reset={reset} showLocations={false} />

      <ErrorState error={summary.error} onRetry={summary.refresh} title={t("dashboard.couldNotLoadTheSummary")} />
      {summary.loading && !data ? (
        <Loading />
      ) : (
        <>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label={t("dashboard.menToday")}
                value={formatNumber(today?.male ?? 0)}
                hint={t("dashboard.v0InTheRange", { v0: formatNumber(range?.male ?? 0) })}
                icon={<BoyIcon />}
                color="primary"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label={t("dashboard.womenToday")}
                value={formatNumber(today?.female ?? 0)}
                hint={t("dashboard.v0InTheRange", { v0: formatNumber(range?.female ?? 0) })}
                icon={<GirlIcon />}
                color="secondary"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label={t("dashboard.childrenToday")}
                value={formatNumber(today?.child ?? 0)}
                hint={t("dashboard.v0InTheRange", { v0: formatNumber(range?.child ?? 0) })}
                icon={<ChildCareIcon />}
                color="warning"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label={t("dashboard.inViewNow")}
                value={formatNumber(now?.total ?? 0)}
                hint={
                  now?.as_of
                    ? `M ${now.male} · F ${now.female} · C ${now.child} · ${fromNow(now.as_of)}`
                    : t("dashboard.noCameraReportedInThe")
                }
                icon={<GroupsIcon />}
                color="info"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label={t("dashboard.visitsInTheRange")}
                value={formatNumber(range?.total ?? 0)}
                hint={t("dashboard.v0NotLabelled", { v0: formatNumber(range?.unknown ?? 0) })}
                icon={<GroupsIcon />}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label={t("dashboard.averageDwell")}
                value={formatDuration(range?.avg_dwell_s)}
                hint={t("dashboard.timeAPersonStaysIn")}
                icon={<TimerIcon />}
                color="success"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label={t("dashboard.maleFemale")}
                value={range?.male_female_ratio ? `${range.male_female_ratio.toFixed(2)} : 1` : "—"}
                hint={t("dashboard.visitsInTheRange")}
                icon={<InsightsIcon />}
                color="secondary"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label={t("dashboard.camerasRunning")}
                value={`${cams?.running ?? 0} / ${cams?.total ?? 0}`}
                hint={t("dashboard.v0Connected", { v0: cams?.connected ?? 0 })}
                icon={<VideocamIcon />}
                color="success"
              />
            </Grid>
          </Grid>

          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, lg: 8 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent>
                  <Typography variant="subtitle2">{t("dashboard.visitsPerDay")}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("dashboard.onePerPersonByThe")}
                  </Typography>
                  <Box sx={{ height: 280, mt: 2 }}>
                    {trend.loading && !trend.data ? (
                      <Loading height={280} />
                    ) : (trend.data?.data?.series || []).length ? (
                      <Bar data={trendChart.data} options={trendChart.options} />
                    ) : (
                      <EmptyState title={t("dashboard.noVisitsInThisRange")} />
                    )}
                  </Box>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, lg: 4 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent>
                  <Typography variant="subtitle2">{t("dashboard.genderMix")}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("dashboard.todayThenTheWholeRange")}
                  </Typography>
                  <Stack spacing={3} sx={{ mt: 2 }}>
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        {t("dashboard.today")}
                      </Typography>
                      <MixBar mix={today} />
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        {t("dashboard.range")}
                      </Typography>
                      <MixBar mix={range} />
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        {t("dashboard.inViewNow")}
                      </Typography>
                      <MixBar mix={now} />
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle2">{t("dashboard.latestSnapshotPerCamera")}</Typography>
              <Typography variant="caption" color="text.secondary">
                {t("dashboard.whoEachCameraHadIn")}
              </Typography>
              {perCamera.length ? (
                <Table size="small" sx={{ mt: 1 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t("dashboard.camera")}</TableCell>
                      <TableCell>{t("dashboard.zone")}</TableCell>
                      <TableCell align="right">{t("dashboard.people")}</TableCell>
                      {GENDERS.map((g) => (
                        <TableCell key={g} align="right">
                          {GENDER_LABEL[g]}
                        </TableCell>
                      ))}
                      <TableCell sx={{ width: "22%" }}>{t("dashboard.mix")}</TableCell>
                      <TableCell align="right">{t("dashboard.when")}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {perCamera.map((row) => (
                      <TableRow key={row.snapshot_id} hover>
                        <TableCell>
                          <RouterLink to={`/cameras/${row.camera_id}`} style={{ color: "inherit" }}>
                            {row.camera_name}
                          </RouterLink>
                        </TableCell>
                        <TableCell>{row.zone || "—"}</TableCell>
                        <TableCell align="right">{row.person_count}</TableCell>
                        <TableCell align="right">{row.male_count}</TableCell>
                        <TableCell align="right">{row.female_count}</TableCell>
                        <TableCell align="right">{row.child_count}</TableCell>
                        <TableCell>
                          <LinearProgress
                            variant="determinate"
                            value={row.person_count ? (100 * row.female_count) / row.person_count : 0}
                            sx={{
                              height: 8,
                              borderRadius: 4,
                              bgcolor: row.person_count ? GENDER_COLOR.male : undefined,
                              "& .MuiLinearProgress-bar": { bgcolor: GENDER_COLOR.female },
                            }}
                          />
                        </TableCell>
                        <TableCell align="right">{fromNow(row.captured_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  title={t("dashboard.noSnapshotsYet")}
                  description={t("dashboard.aRunningCameraWritesOne")}
                  action={
                    <Button component={RouterLink} to="/cameras" variant="outlined">
                      {t("dashboard.cameras")}
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </Box>
  );
}
