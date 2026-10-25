import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TablePagination from "@mui/material/TablePagination";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import MarkEmailReadIcon from "@mui/icons-material/MarkEmailRead";
import MarkEmailUnreadIcon from "@mui/icons-material/MarkEmailUnread";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";

import { notifications as notificationsApi } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import PageHeader from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useNotifications } from "../notifications/NotificationsContext";
import { NotificationIcon, useOpenNotification } from "../notifications/parts";
import { useWorkspace } from "../workspace/WorkspaceContext";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABEL,
  PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
} from "../utils/constants";
import { formatDateTime, fromNow } from "../utils/format";

/**
 * Every notification the account can see, across its workspaces: occupancy
 * alerts (a camera's alert thresholds, set on its edit page) and cameras
 * going offline and coming back.
 */
export default function Notifications() {
  const toast = useToast();
  const workspace = useWorkspace();
  const { version, markRead, markUnread, markAllRead } = useNotifications();
  const open = useOpenNotification();
  const [show, setShow] = useState("all");
  const [kind, setKind] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(PAGE_SIZE);

  const request = useAsync(
    ({ signal }) =>
      notificationsApi.list(
        {
          unread_only: show === "unread" || undefined,
          kind: kind || undefined,
          workspace_id: workspaceId || undefined,
          limit: rowsPerPage,
          offset: page * rowsPerPage,
        },
        { signal }
      ),
    // version: a live notification arrived, or the stream reconnected.
    [show, kind, workspaceId, page, rowsPerPage, version]
  );
  const data = request.data;

  const filtered = (setter) => (value) => {
    setter(value);
    setPage(0);
  };

  const toggleRead = async (item) => {
    try {
      if (item.is_read) await markUnread(item.notification_id);
      else await markRead(item.notification_id);
      request.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const readAll = async () => {
    try {
      const result = await markAllRead();
      toast.success(`${result.marked} marked read.`);
      request.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Box>
      <PageHeader
        title="Notifications"
        subtitle="Crowding and low-occupancy alerts from each camera's thresholds, and cameras that stopped or resumed delivering frames."
        actions={[
          <Button key="all" startIcon={<DoneAllIcon />} onClick={readAll} disabled={!data?.unread}>
            Mark all read
          </Button>,
        ]}
      />

      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap" alignItems="center" sx={{ mb: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={show}
          onChange={(_, value) => value && filtered(setShow)(value)}
          aria-label="Show"
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="unread">Unread{data?.unread ? ` (${data.unread})` : ""}</ToggleButton>
        </ToggleButtonGroup>
        <TextField
          select
          size="small"
          label="Kind"
          value={kind}
          onChange={(e) => filtered(setKind)(e.target.value)}
          sx={{ minWidth: 170 }}
        >
          <MenuItem value="">All kinds</MenuItem>
          {NOTIFICATION_KINDS.map((k) => (
            <MenuItem key={k} value={k}>
              {NOTIFICATION_KIND_LABEL[k]}
            </MenuItem>
          ))}
        </TextField>
        {workspace.workspaces.length > 1 ? (
          <TextField
            select
            size="small"
            label="Workspace"
            value={workspaceId}
            onChange={(e) => filtered(setWorkspaceId)(e.target.value)}
            sx={{ minWidth: 170 }}
          >
            <MenuItem value="">All workspaces</MenuItem>
            {workspace.workspaces.map((w) => (
              <MenuItem key={w.workspace_id} value={w.workspace_id}>
                {w.name}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
      </Stack>

      <ErrorState error={request.error} onRetry={request.refresh} title="Could not load notifications" />
      <Card>
        {request.loading && !data ? (
          <Loading />
        ) : data?.items?.length ? (
          <>
            <List disablePadding aria-label="Notifications">
              {data.items.map((item) => (
                <ListItem
                  key={item.notification_id}
                  disablePadding
                  divider
                  secondaryAction={
                    <Tooltip title={item.is_read ? "Mark unread" : "Mark read"}>
                      <IconButton
                        edge="end"
                        aria-label={item.is_read ? "Mark unread" : "Mark read"}
                        onClick={() => toggleRead(item)}
                      >
                        {item.is_read ? <MarkEmailUnreadIcon /> : <MarkEmailReadIcon />}
                      </IconButton>
                    </Tooltip>
                  }
                  sx={{ bgcolor: item.is_read ? "transparent" : "action.hover" }}
                >
                  <ListItemButton
                    onClick={() => open(item)}
                    sx={{ alignItems: "flex-start", pr: 7 }}
                  >
                    <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                      <NotificationIcon item={item} fontSize="medium" />
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                          <Box component="span" sx={{ fontWeight: item.is_read ? 500 : 700 }}>
                            {item.title}
                          </Box>
                          <Chip size="small" variant="outlined" label={NOTIFICATION_KIND_LABEL[item.kind]} />
                          {item.workspace_id !== workspace.active?.workspace_id ? (
                            <Chip size="small" label={item.workspace_name} />
                          ) : null}
                        </Stack>
                      }
                      secondary={
                        <>
                          <Box component="span" sx={{ display: "block", mt: 0.5, color: "text.primary" }}>
                            {item.message}
                          </Box>
                          <Tooltip title={formatDateTime(item.created_at)}>
                            <Box component="span" sx={{ display: "inline-block", mt: 0.5, fontSize: 12 }}>
                              {fromNow(item.created_at)}
                              {!item.camera_id && item.camera_name ? ` · ${item.camera_name} (deleted)` : ""}
                            </Box>
                          </Tooltip>
                        </>
                      }
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
            <TablePagination
              component="div"
              count={data.total}
              page={page}
              rowsPerPage={rowsPerPage}
              rowsPerPageOptions={PAGE_SIZE_OPTIONS}
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
            title={show === "unread" ? "All caught up" : "No notifications"}
            description="Set a camera's alert thresholds on its edit page to be told about crowding. Cameras that stop delivering frames are reported on their own."
            icon={<NotificationsNoneIcon fontSize="inherit" />}
          />
        )}
      </Card>
    </Box>
  );
}
