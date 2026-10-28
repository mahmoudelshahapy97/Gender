import { AppShell, NotificationBell, NotificationsProvider, useNotifications } from "@insighteye/ui";
import { useTranslation } from "react-i18next";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import VideocamIcon from "@mui/icons-material/Videocam";
import GridViewIcon from "@mui/icons-material/GridView";
import InsightsIcon from "@mui/icons-material/Insights";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import PhotoLibraryIcon from "@mui/icons-material/PhotoLibrary";
import TuneIcon from "@mui/icons-material/Tune";
import GroupIcon from "@mui/icons-material/Group";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import NotificationsIcon from "@mui/icons-material/Notifications";
import HistoryIcon from "@mui/icons-material/History";
import WcIcon from "@mui/icons-material/Wc";

/**
 * Watch the cameras, then read the gender analytics back. `perm` is the role
 * floor the API enforces for the same action.
 */
function Shell() {
  const { t } = useTranslation();
  const { unread } = useNotifications();

  const navSections = [
    {
      heading: t("shell.monitor"),
      items: [
        { to: "/", label: t("nav.dashboard"), icon: <DashboardIcon />, end: true, perm: "viewer" },
        { to: "/cameras", label: t("nav.cameras"), icon: <VideocamIcon />, perm: "viewer" },
        { to: "/live", label: t("nav.liveWall"), icon: <GridViewIcon />, perm: "viewer" },
        { to: "/notifications", label: t("nav.notifications"), icon: <NotificationsIcon />, perm: "viewer", badge: "unread" },
      ],
    },
    {
      heading: t("layout.genderAnalytics"),
      items: [
        { to: "/analytics", label: t("nav.analytics"), icon: <InsightsIcon />, perm: "viewer" },
        { to: "/visits", label: t("layout.visits"), icon: <DirectionsWalkIcon />, perm: "viewer" },
        { to: "/snapshots", label: t("layout.snapshots"), icon: <PhotoLibraryIcon />, perm: "viewer" },
      ],
    },
    {
      heading: t("shell.system"),
      items: [
        { to: "/system", label: t("nav.system"), icon: <TuneIcon />, perm: "viewer" },
        { to: "/workspaces", label: t("nav.workspaces"), icon: <WorkspacesIcon />, perm: "admin" },
        { to: "/users", label: t("nav.users"), icon: <GroupIcon />, perm: "admin" },
        { to: "/audit", label: t("nav.audit"), icon: <HistoryIcon />, perm: "admin" },
      ],
    },
  ];

  return (
    <AppShell
      product={{ brand: "InsightEye", tagline: t("product.tagline"), icon: <WcIcon /> }}
      navSections={navSections}
      badges={{ unread }}
      topBarExtras={<NotificationBell />}
    />
  );
}

export function AppLayout() {
  return (
    <NotificationsProvider>
      <Shell />
    </NotificationsProvider>
  );
}

export default AppLayout;
