import { useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Grid from "@mui/material/Grid2";
import Pagination from "@mui/material/Pagination";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ImageNotSupportedIcon from "@mui/icons-material/ImageNotSupported";

import { snapshots } from "../api/endpoints";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import GenderChip from "../components/GenderChip";
import GenderFilterBar from "../components/GenderFilterBar";
import PageHeader from "../components/PageHeader";
import { useAsync } from "../hooks/useAsync";
import { useFilters } from "../hooks/useFilters";
import { GENDERS } from "../utils/constants";
import { formatDateTime, fromNow } from "../utils/format";
import { useTranslation } from "react-i18next";

const PER_PAGE = 24;

function Counts({ row }) {
  return (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
      {GENDERS.map((g) =>
        row[`${g}_count`] ? <GenderChip key={g} gender={g} suffix={row[`${g}_count`]} /> : null
      )}
      {row.unknown_count ? <GenderChip gender="unknown" suffix={row.unknown_count} /> : null}
    </Stack>
  );
}

function Frame({ row, height }) {
  const { t } = useTranslation();
  if (!row.has_frame) {
    return (
      <Box sx={{ height, display: "grid", placeItems: "center", bgcolor: "action.hover" }}>
        <ImageNotSupportedIcon color="disabled" />
      </Box>
    );
  }
  return (
    <CardMedia
      component="img"
      loading="lazy"
      src={snapshots.frameUrl(row.snapshot_id)}
      alt={t("snapshots.cameraNameAtV1", { camera_name: row.camera_name, v1: formatDateTime(row.captured_at) })}
      sx={{ height, objectFit: "cover", bgcolor: "black" }}
    />
  );
}

export default function Snapshots() {
  const { t } = useTranslation();
  const { filters, setFilters, reset, params, paramsKey } = useFilters();
  const [page, setPage] = useState(1);
  const [minPeople, setMinPeople] = useState(1);
  const [open, setOpen] = useState(null);

  const request = useAsync(
    ({ signal }) =>
      snapshots.list(
        { ...params, min_people: minPeople || undefined, limit: PER_PAGE, offset: (page - 1) * PER_PAGE },
        { signal }
      ),
    [paramsKey, page, minPeople]
  );
  const data = request.data?.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;

  return (
    <Box>
      <PageHeader
        title={t("snapshots.snapshots")}
        subtitle={t("snapshots.whoEachCameraHadIn")}
      />
      <GenderFilterBar
        filters={filters}
        setFilters={(update) => {
          setPage(1);
          setFilters(update);
        }}
        reset={reset}
      />

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <TextField
          type="number"
          size="small"
          label={t("snapshots.atLeastNPeople")}
          value={minPeople}
          onChange={(e) => {
            setMinPeople(Math.max(0, Number(e.target.value) || 0));
            setPage(1);
          }}
          sx={{ width: 170 }}
          slotProps={{ htmlInput: { min: 0 } }}
        />
        {data && (
          <Typography variant="body2" color="text.secondary">
            {t("snapshots.v0SnapshotS", { v0: data.total.toLocaleString() })}
          </Typography>
        )}
      </Stack>

      <ErrorState error={request.error} onRetry={request.refresh} title={t("snapshots.couldNotLoadSnapshots")} />
      {request.loading && !data ? (
        <Loading />
      ) : data?.items?.length ? (
        <>
          <Grid container spacing={2}>
            {data.items.map((row) => (
              <Grid key={row.snapshot_id} size={{ xs: 12, sm: 6, md: 4, xl: 3 }}>
                <Card>
                  <CardActionArea onClick={() => setOpen(row)}>
                    <Frame row={row} height={180} />
                    <CardContent>
                      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                        <Typography variant="subtitle2" noWrap>
                          {row.camera_name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {fromNow(row.captured_at)}
                        </Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                        {t("snapshots.v0PersonCountInView", { v0: formatDateTime(row.captured_at), person_count: row.person_count })}
                      </Typography>
                      <Counts row={row} />
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Grid>
            ))}
          </Grid>
          <Stack alignItems="center" sx={{ mt: 3 }}>
            <Pagination count={pages} page={page} onChange={(_, next) => setPage(next)} />
          </Stack>
        </>
      ) : (
        <EmptyState
          title={t("snapshots.noSnapshots")}
          description={t("snapshots.aRunningCameraWritesOne")}
        />
      )}

      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} maxWidth="lg" fullWidth>
        {open && (
          <>
            <DialogTitle>
              {open.camera_name} · {formatDateTime(open.captured_at)}
            </DialogTitle>
            <DialogContent>
              {open.has_frame && (
                <Box
                  component="img"
                  src={snapshots.frameUrl(open.snapshot_id)}
                  alt={t("snapshots.annotatedFrame")}
                  sx={{ width: "100%", borderRadius: 1, mb: 2 }}
                />
              )}
              <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="body2">{t("snapshots.personCountInView", { person_count: open.person_count })}</Typography>
                <Counts row={open} />
                <Typography variant="body2" color="text.secondary">
                  {[open.location, open.area, open.building, open.floor_level, open.zone]
                    .filter(Boolean)
                    .join(" › ") || t("snapshots.noLocationSet")}
                </Typography>
              </Stack>
            </DialogContent>
          </>
        )}
      </Dialog>
    </Box>
  );
}
