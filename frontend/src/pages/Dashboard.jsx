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

const pct = (value) => (value === null || value === undefined ? "—" : `${value.toFixed(0)}%`);

/** A single bar split male / female / child by share. */
function MixBar({ mix }) {
  const labelled = GENDERS.reduce((sum, g) => sum + (mix?.[g] || 0), 0);
  if (!labelled) {
    return (
      <Typography variant="caption" color="text.secondary">
        Nobody labelled yet
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
        title="Dashboard"
        subtitle="Who came in, and who is in view right now, by gender."
        actions={[
          <Button key="analytics" component={RouterLink} to="/analytics" startIcon={<InsightsIcon />}>
            Open analytics
          </Button>,
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <GenderFilterBar filters={filters} setFilters={setFilters} reset={reset} showLocations={false} />

      <ErrorState error={summary.error} onRetry={summary.refresh} title="Could not load the summary" />
      {summary.loading && !data ? (
        <Loading />
      ) : (
        <>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label="Men today"
                value={formatNumber(today?.male ?? 0)}
                hint={`${formatNumber(range?.male ?? 0)} in the range`}
                icon={<BoyIcon />}
                color="primary"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label="Women today"
                value={formatNumber(today?.female ?? 0)}
                hint={`${formatNumber(range?.female ?? 0)} in the range`}
                icon={<GirlIcon />}
                color="secondary"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label="Children today"
                value={formatNumber(today?.child ?? 0)}
                hint={`${formatNumber(range?.child ?? 0)} in the range`}
                icon={<ChildCareIcon />}
                color="warning"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                label="In view now"
                value={formatNumber(now?.total ?? 0)}
                hint={
                  now?.as_of
                    ? `M ${now.male} · F ${now.female} · C ${now.child} · ${fromNow(now.as_of)}`
                    : "No camera reported in the last 10 minutes"
                }
                icon={<GroupsIcon />}
                color="info"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label="Visits in the range"
                value={formatNumber(range?.total ?? 0)}
                hint={`${formatNumber(range?.unknown ?? 0)} not labelled`}
                icon={<GroupsIcon />}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label="Average dwell"
                value={formatDuration(range?.avg_dwell_s)}
                hint="Time a person stays in view"
                icon={<TimerIcon />}
                color="success"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label="Male : female"
                value={range?.male_female_ratio ? `${range.male_female_ratio.toFixed(2)} : 1` : "—"}
                hint="Visits in the range"
                icon={<InsightsIcon />}
                color="secondary"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <StatCard
                dense
                label="Cameras running"
                value={`${cams?.running ?? 0} / ${cams?.total ?? 0}`}
                hint={`${cams?.connected ?? 0} connected`}
                icon={<VideocamIcon />}
                color="success"
              />
            </Grid>
          </Grid>

          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, lg: 8 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent>
                  <Typography variant="subtitle2">Visits per day</Typography>
                  <Typography variant="caption" color="text.secondary">
                    One per person, by the gender their track settled on
                  </Typography>
                  <Box sx={{ height: 280, mt: 2 }}>
                    {trend.loading && !trend.data ? (
                      <Loading height={280} />
                    ) : (trend.data?.data?.series || []).length ? (
                      <Bar data={trendChart.data} options={trendChart.options} />
                    ) : (
                      <EmptyState title="No visits in this range" />
                    )}
                  </Box>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, lg: 4 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent>
                  <Typography variant="subtitle2">Gender mix</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Today, then the whole range
                  </Typography>
                  <Stack spacing={3} sx={{ mt: 2 }}>
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        Today
                      </Typography>
                      <MixBar mix={today} />
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        Range
                      </Typography>
                      <MixBar mix={range} />
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        In view now
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
              <Typography variant="subtitle2">Latest snapshot per camera</Typography>
              <Typography variant="caption" color="text.secondary">
                Who each camera had in view at its last snapshot
              </Typography>
              {perCamera.length ? (
                <Table size="small" sx={{ mt: 1 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Camera</TableCell>
                      <TableCell>Zone</TableCell>
                      <TableCell align="right">People</TableCell>
                      {GENDERS.map((g) => (
                        <TableCell key={g} align="right">
                          {GENDER_LABEL[g]}
                        </TableCell>
                      ))}
                      <TableCell sx={{ width: "22%" }}>Mix</TableCell>
                      <TableCell align="right">When</TableCell>
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
                  title="No snapshots yet"
                  description="A running camera writes one every minute."
                  action={
                    <Button component={RouterLink} to="/cameras" variant="outlined">
                      Cameras
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
