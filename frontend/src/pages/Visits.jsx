import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import DownloadIcon from "@mui/icons-material/Download";

import { visits } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import GenderChip from "../components/GenderChip";
import GenderFilterBar from "../components/GenderFilterBar";
import PageHeader from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useFilters } from "../hooks/useFilters";
import { GENDER_LABEL, PAGE_SIZE, PAGE_SIZE_OPTIONS, VISIT_GENDERS } from "../utils/constants";
import { formatDateTime, formatDuration, formatScore } from "../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

/** "male 1.6 · female 0.4" - the confidence-weighted votes behind a label. */
const describeVotes = (votes) =>
  Object.entries(votes || {})
    .sort((a, b) => b[1] - a[1])
    .map(([label, weight]) => `${GENDER_LABEL[label] || label} ${Number(weight).toFixed(2)}`)
    .join(" · ") || i18n.t("visits.noVotes");

export default function Visits() {
  const { t } = useTranslation();
  const toast = useToast();
  const { filters, setFilters, reset, params, paramsKey } = useFilters();
  const [gender, setGender] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(PAGE_SIZE);
  const [exporting, setExporting] = useState(false);

  const query = { ...params, gender: gender || undefined };
  const request = useAsync(
    ({ signal }) => visits.list({ ...query, limit: rowsPerPage, offset: page * rowsPerPage }, { signal }),
    [paramsKey, gender, page, rowsPerPage]
  );
  const data = request.data?.data;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await visits.exportCsv(query);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `visits-${filters.start_date || "all"}-${filters.end_date || "now"}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err) || t("visits.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Box>
      <PageHeader
        title={t("visits.visits")}
        subtitle={t("visits.oneRowPerPersonWhen")}
        actions={[
          <Button key="csv" startIcon={<DownloadIcon />} onClick={exportCsv} disabled={exporting}>
            {t("visits.exportCsv")}
          </Button>,
        ]}
      />
      <GenderFilterBar
        filters={filters}
        setFilters={(update) => {
          setPage(0);
          setFilters(update);
        }}
        reset={reset}
      />

      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label={t("visits.gender")}
          value={gender}
          onChange={(e) => {
            setGender(e.target.value);
            setPage(0);
          }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">{t("visits.all")}</MenuItem>
          {VISIT_GENDERS.map((g) => (
            <MenuItem key={g} value={g}>
              {GENDER_LABEL[g]}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <ErrorState error={request.error} onRetry={request.refresh} title={t("visits.couldNotLoadVisits")} />
      <Card>
        {request.loading && !data ? (
          <Loading />
        ) : data?.items?.length ? (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("visits.firstSeen")}</TableCell>
                    <TableCell>{t("visits.camera")}</TableCell>
                    <TableCell>{t("visits.zone")}</TableCell>
                    <TableCell>{t("visits.gender")}</TableCell>
                    <TableCell align="right">{t("visits.confidence")}</TableCell>
                    <TableCell align="right">{t("visits.dwell")}</TableCell>
                    <TableCell>{t("visits.lastSeen")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.items.map((row) => (
                    <TableRow key={row.visit_id} hover>
                      <TableCell>{formatDateTime(row.first_seen)}</TableCell>
                      <TableCell>{row.camera_name}</TableCell>
                      <TableCell>{row.zone || "—"}</TableCell>
                      <TableCell>
                        <Tooltip title={describeVotes(row.votes)}>
                          <span>
                            <GenderChip gender={row.gender} />
                          </span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right">{formatScore(row.confidence, 0)}</TableCell>
                      <TableCell align="right">{formatDuration(row.dwell_s)}</TableCell>
                      <TableCell>{formatDateTime(row.last_seen)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <TablePagination
              component="div"
              count={data.total}
              page={page}
              rowsPerPage={rowsPerPage}
              rowsPerPageOptions={PAGE_SIZE_OPTIONS}
              // On a phone the page-size picker pushes the next-page arrow off
              // the edge; the range and the arrows are what matter there.
              sx={{
                "& .MuiTablePagination-selectLabel, & .MuiTablePagination-input": {
                  display: { xs: "none", sm: "inline-flex" },
                },
              }}
              onPageChange={(_, next) => setPage(next)}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(Number(e.target.value));
                setPage(0);
              }}
            />
          </>
        ) : (
          <EmptyState
            title={t("visits.noVisits")}
            description={t("visits.aVisitIsWrittenWhen")}
          />
        )}
      </Card>
    </Box>
  );
}
