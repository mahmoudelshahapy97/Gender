import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import NotificationsIcon from "@mui/icons-material/Notifications";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";

import { useNotifications } from "../notifications/NotificationsContext";
import { NotificationIcon, useOpenNotification } from "../notifications/parts";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { fromNow } from "../utils/format";

/** The bar's bell: unread count, and the latest few one click away. */
export function NotificationBell() {
  const { recent, unread, live, markAllRead } = useNotifications();
  const workspace = useWorkspace();
  const open = useOpenNotification();
  const [anchorEl, setAnchorEl] = useState(null);
  const close = () => setAnchorEl(null);

  const label = unread ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <>
      <Tooltip title={live ? label : `${label} (reconnecting…)`}>
        <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} aria-label={label}>
          <Badge badgeContent={unread} max={99} color="error">
            {unread ? <NotificationsIcon /> : <NotificationsNoneIcon />}
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: "calc(100vw - 32px)" } } }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 2, py: 1.25 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Notifications
          </Typography>
          <Button size="small" onClick={() => markAllRead()} disabled={!unread}>
            Mark all read
          </Button>
        </Stack>
        <Divider />
        {recent && recent.length ? (
          <List dense disablePadding aria-label="Latest notifications" sx={{ maxHeight: 420, overflowY: "auto" }}>
            {recent.map((item) => (
              <ListItemButton
                key={item.notification_id}
                onClick={() => {
                  close();
                  open(item);
                }}
                sx={{
                  alignItems: "flex-start",
                  bgcolor: item.is_read ? "transparent" : "action.hover",
                }}
              >
                <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
                  <NotificationIcon item={item} />
                </ListItemIcon>
                <ListItemText
                  primary={item.title}
                  primaryTypographyProps={{ fontWeight: item.is_read ? 500 : 700, noWrap: true }}
                  secondary={
                    <>
                      <Box
                        component="span"
                        sx={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {item.message}
                      </Box>
                      <Box component="span" sx={{ display: "block", mt: 0.25, fontSize: 12 }}>
                        {fromNow(item.created_at)}
                        {item.workspace_id !== workspace.active?.workspace_id && item.workspace_name
                          ? ` · ${item.workspace_name}`
                          : ""}
                      </Box>
                    </>
                  }
                />
              </ListItemButton>
            ))}
          </List>
        ) : (
          <Box sx={{ px: 2, py: 4, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">
              {recent ? "Nothing yet. Crowding alerts and camera outages show up here." : "Loading…"}
            </Typography>
          </Box>
        )}
        <Divider />
        <Box sx={{ p: 1, textAlign: "center" }}>
          <Button component={RouterLink} to="/notifications" onClick={close} size="small">
            See all
          </Button>
        </Box>
      </Popover>
    </>
  );
}

export default NotificationBell;
