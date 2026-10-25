import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";

import ConfirmDialog from "../../components/ConfirmDialog";
import ItemImage from "../../components/ItemImage";
import PageHeader from "../../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import { EnabledChip } from "../../components/StatusChips";
import GenderChip from "../../components/GenderChip";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../api/client";
import { cameras as cameraApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../hooks/useAsync";
import { usePolling } from "../../hooks/usePolling";
import { GENDERS, GENDER_LABEL, POLL_INTERVAL_MS, placeOf } from "../../utils/constants";
import { formatDateTime, formatDuration, parseJsonField, redactUrl, titleCase } from "../../utils/format";

function DetailRow({ label, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 140, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

export default function CameraDetail() {
  const { cameraId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canOperate = hasRole("operator");
  const canManage = hasRole("admin");

  const camera = useAsync(({ signal }) => cameraApi.get(cameraId, { signal }), [cameraId]);
  const status = usePolling(({ signal }) => cameraApi.status(cameraId, { signal }), {
    intervalMs: POLL_INTERVAL_MS,
    deps: [cameraId],
  });

  // Bumping this changes the snapshot URL, which is what makes the browser
  // re-request the frame rather than serve the one it already has.
  const [snapshotKey, setSnapshotKey] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const worker = status.data?.data;
  const running = Boolean(worker?.running);
  const people = worker?.people || [];
  const occupancy = worker?.occupancy;

  // The live stream ends when the worker stops or the supervisor replaces it.
  // Fall back to the snapshot then, and reconnect whenever a new worker starts.
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamKey, setStreamKey] = useState(() => Date.now());
  const workerStartedAt = worker?.started_at;
  useEffect(() => {
    setStreamFailed(false);
    setStreamKey(Date.now());
  }, [running, workerStartedAt]);
  const live = running && !streamFailed;

  // jsonb arrives as a string; parse once here rather than at every read.
  const roi = parseJsonField(camera.data?.roi);
  const settings = parseJsonField(camera.data?.settings, {}) || {};

  const runAction = async (action, message) => {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      status.refresh();
      camera.refresh();
      setSnapshotKey(Date.now());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await cameraApi.remove(cameraId);
      toast.success(`Camera "${camera.data?.name}" deleted.`);
      navigate("/cameras");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  if (camera.loading && !camera.data) return <Loading label="Loading camera…" />;
  if (camera.error) return <ErrorState error={camera.error} onRetry={camera.refresh} />;
  if (!camera.data) return null;

  return (
    <Box>
      <Button component={RouterLink} to="/cameras" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        All cameras
      </Button>

      <PageHeader
        title={camera.data.name}
        subtitle={placeOf(camera.data) || "No location set"}
        actions={[
          canOperate &&
            (running ? (
              <Button
                key="stop"
                variant="outlined"
                color="warning"
                startIcon={<StopIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.stop(cameraId), "Worker stopped.")}
              >
                Stop worker
              </Button>
            ) : (
              <Button
                key="start"
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.start(cameraId), "Worker started.")}
              >
                Start worker
              </Button>
            )),
          <Button key="visits" component={RouterLink} to="/visits">
            Visits
          </Button>,
          canManage && (
            <Button
              key="edit"
              component={RouterLink}
              to={`/cameras/${cameraId}/edit`}
              startIcon={<EditIcon />}
            >
              Edit
            </Button>
          ),
          canManage && (
            <Button
              key="delete"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          ),
        ]}
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 1.5 }}
            >
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {live ? "Live view" : "Snapshot"}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {live
                    ? "Tracking as it happens: each person is boxed in the colour of their gender label."
                    : "The worker's latest frame, or a one-shot grab when it is stopped."}
                </Typography>
              </Box>
              {live ? (
                <Chip size="small" color="error" label="LIVE" />
              ) : (
                <Button
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={() => {
                    setSnapshotKey(Date.now());
                    if (running) setStreamFailed(false);
                  }}
                >
                  Refresh frame
                </Button>
              )}
            </Stack>
            <Divider />
            {live ? (
              <Box
                component="img"
                key={streamKey}
                src={cameraApi.streamUrl(cameraId, streamKey)}
                alt={`Live view from ${camera.data.name}`}
                onError={() => setStreamFailed(true)}
                sx={{
                  height: 380,
                  width: "100%",
                  objectFit: "contain",
                  display: "block",
                  bgcolor: "common.black",
                }}
              />
            ) : (
              <ItemImage
                key={snapshotKey}
                src={cameraApi.snapshotUrl(cameraId, snapshotKey)}
                alt={`Snapshot from ${camera.data.name}`}
                height={380}
                fit="contain"
                fallbackLabel="No frame — the RTSP source is not answering"
              />
            )}
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Configuration
              </Typography>
              <Divider />
              <DetailRow label="State">
                <EnabledChip enabled={camera.data.enabled} />
              </DetailRow>
              <DetailRow label="RTSP URL">
                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                  {redactUrl(camera.data.rtsp_url)}
                </Typography>
              </DetailRow>
              <DetailRow label="Place">
                <Typography variant="body2" color="text.secondary">
                  {placeOf(camera.data) || "Not set"}
                </Typography>
              </DetailRow>
              <DetailRow label="Region of interest">
                <Typography variant="body2" color="text.secondary">
                  {roi?.length ? `${roi.length}-point polygon` : "Whole frame"}
                </Typography>
              </DetailRow>
              <DetailRow label="Overrides">
                {Object.keys(settings).length ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {Object.entries(settings).map(([key, value]) => (
                      <Chip key={key} size="small" variant="outlined" label={`${key}: ${value}`} />
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Inheriting every global default
                  </Typography>
                )}
              </DetailRow>
              <DetailRow label="Registered">
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(camera.data.created_at)}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Worker
              </Typography>
              <Divider />
              {running ? (
                <>
                  <DetailRow label="Connection">
                    <Chip
                      size="small"
                      color={
                        worker.state === "error"
                          ? "error"
                          : worker.connected
                            ? "success"
                            : "warning"
                      }
                      label={
                        worker.state === "error"
                          ? "Error — supervisor will restart it"
                          : worker.connected
                            ? "Streaming"
                            : titleCase(worker.state || "reconnecting")
                      }
                    />
                  </DetailRow>
                  <DetailRow label="Last frame">
                    <Typography variant="body2" color="text.secondary">
                      {worker.last_frame_at
                        ? `${formatDuration(worker.seconds_since_frame)} ago · ${worker.fps ?? 0} fps`
                        : "None yet"}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Reconnects">
                    <Typography variant="body2">
                      {worker.reconnects ?? 0}
                      {worker.supervisor_restarts
                        ? ` · ${worker.supervisor_restarts} supervisor restart(s)`
                        : ""}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Started">
                    <Typography variant="body2" color="text.secondary">
                      {formatDateTime(worker.started_at)}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Frames processed">
                    <Typography variant="body2">{worker.frames_processed ?? 0}</Typography>
                  </DetailRow>
                  <DetailRow label="Recorded">
                    <Typography variant="body2">
                      {worker.visits_recorded ?? 0} visit(s) · {worker.snapshots_recorded ?? 0} snapshot(s)
                    </Typography>
                  </DetailRow>
                  {worker.last_error ? (
                    <DetailRow label="Last error">
                      <Typography variant="body2" color="error.main">
                        {worker.last_error}
                      </Typography>
                    </DetailRow>
                  ) : null}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  Not running. Nothing from this camera is being analysed.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={12}>
          <Card>
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                People in view
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Each tracked person and the votes gender.pt has cast for them. A label settles once
                it has enough votes; until then the person counts as unknown.
              </Typography>
              {occupancy ? (
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={`${occupancy.person_count} in view`} />
                  {GENDERS.map((g) => (
                    <GenderChip key={g} gender={g} suffix={occupancy[`${g}_count`]} />
                  ))}
                  <GenderChip gender="unknown" suffix={occupancy.unknown_count} />
                </Stack>
              ) : null}
            </Box>
            <Divider />
            {people.length ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Track</TableCell>
                    <TableCell>Gender</TableCell>
                    <TableCell>Votes</TableCell>
                    <TableCell align="right">In view for</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {people.map((person) => (
                    <TableRow key={person.track_id} hover>
                      <TableCell>#{person.track_id}</TableCell>
                      <TableCell>
                        <GenderChip gender={person.gender} />
                      </TableCell>
                      <TableCell>
                        {Object.entries(person.votes || {})
                          .map(([label, weight]) => `${GENDER_LABEL[label] || label} ${weight}`)
                          .join(" · ") || "—"}
                      </TableCell>
                      <TableCell align="right">{formatDuration(person.seconds_in_view)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                title={running ? "Nobody in view" : "Worker is stopped"}
                description={
                  running
                    ? "People appear here as soon as the people model picks them up."
                    : "Start the worker to see live counting."
                }
              />
            )}
          </Card>
        </Grid>
      </Grid>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${camera.data.name}”?`}
        description="This also deletes every visit and snapshot this camera recorded, with their frames."
        confirmLabel="Delete"
        confirmColor="error"
        busy={busy}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Box>
  );
}
