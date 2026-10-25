import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonOffIcon from "@mui/icons-material/PersonOff";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import VideocamOffIcon from "@mui/icons-material/VideocamOff";

import { useWorkspace } from "../workspace/WorkspaceContext";
import { SEVERITY_COLOR } from "../utils/constants";
import { useNotifications } from "./NotificationsContext";

const KIND_ICON = {
  occupancy_high: GroupsIcon,
  occupancy_low: PersonOffIcon,
  camera_offline: VideocamOffIcon,
  camera_online: TaskAltIcon,
};

/** The kind's icon, in its severity's colour. */
export function NotificationIcon({ item, fontSize = "small" }) {
  const Icon = KIND_ICON[item.kind] || ErrorOutlineIcon;
  return <Icon fontSize={fontSize} color={SEVERITY_COLOR[item.severity] || "action"} />;
}

/**
 * What clicking a notification does: mark it read and open its camera. A
 * camera in another workspace is opened by switching to that workspace
 * first -- every page reads the active one, so it would 404 otherwise.
 */
export function useOpenNotification() {
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const { markRead } = useNotifications();

  return useCallback(
    (item) => {
      if (!item.is_read) markRead(item.notification_id).catch(() => {});
      if (!item.camera_id) return;
      if (workspace.active && item.workspace_id !== workspace.active.workspace_id) {
        workspace.setActive(item.workspace_id);
      }
      navigate(`/cameras/${item.camera_id}`);
    },
    [markRead, navigate, workspace]
  );
}
