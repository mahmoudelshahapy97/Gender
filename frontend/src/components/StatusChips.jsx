import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { useTranslation } from "react-i18next";

/** Whether a camera is configured to run, which is not whether it *is* running. */
export function EnabledChip({ enabled, size = "small", ...props }) {
  const { t } = useTranslation();
  return (
    <Chip
      label={enabled ? t("statusChips.enabled") : t("statusChips.disabled")}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  const { t } = useTranslation();
  if (!worker || !worker.running) {
    return <Chip label={t("statusChips.stopped")} size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? t("statusChips.v0FramesProcessed", { v0: worker.frames_processed ?? 0 })
          : t("statusChips.workerIsUpButThe")
      }
    >
      <Chip
        label={worker.connected ? t("statusChips.streaming") : t("statusChips.reconnecting")}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}
