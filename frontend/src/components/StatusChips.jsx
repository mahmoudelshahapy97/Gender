import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";

/** Whether a camera is configured to run, which is not whether it *is* running. */
export function EnabledChip({ enabled, size = "small", ...props }) {
  return (
    <Chip
      label={enabled ? "Enabled" : "Disabled"}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  if (!worker || !worker.running) {
    return <Chip label="Stopped" size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? `${worker.frames_processed ?? 0} frames processed`
          : "Worker is up but the RTSP source is not answering"
      }
    >
      <Chip
        label={worker.connected ? "Streaming" : "Reconnecting"}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}
