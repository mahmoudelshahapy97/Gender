import { NotificationsPage } from "@insighteye/ui";
import { useTranslation } from "react-i18next";

/** The kinds this backend raises (app/services/notification_service.py KINDS). */
const KINDS = ["occupancy_high", "occupancy_low", "camera_offline", "camera_online", "system"];

export default function Notifications() {
  const { t } = useTranslation();
  return <NotificationsPage kinds={KINDS} subtitle={t("notificationsPage.subtitle")} />;
}
