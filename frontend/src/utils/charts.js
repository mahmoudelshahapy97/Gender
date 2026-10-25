import { useMemo } from "react";
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";

ChartJS.register(
  ArcElement,
  BarElement,
  CategoryScale,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip
);

export { ChartJS };

/**
 * The options every chart starts from: theme-coloured ticks, no vertical grid,
 * one tooltip per x position. Pages spread it and add what they need.
 */
export function useBaseOptions(theme, { stacked = false, integer = false } = {}) {
  return useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          stacked,
          ticks: { color: theme.palette.text.secondary, maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false },
          border: { color: theme.palette.divider },
        },
        y: {
          stacked,
          beginAtZero: true,
          ticks: { color: theme.palette.text.secondary, ...(integer ? { precision: 0 } : {}) },
          grid: { color: theme.palette.divider },
          border: { display: false },
        },
      },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: {
            color: theme.palette.text.secondary,
            boxWidth: 10,
            boxHeight: 10,
            useBorderRadius: true,
            borderRadius: 2,
          },
        },
      },
    }),
    [theme, stacked, integer]
  );
}

/** A 1px surface-coloured edge on each bar leaves a gap between neighbours. */
export const barStyle = (theme) => ({
  borderColor: theme.palette.background.paper,
  borderWidth: 1,
  borderRadius: 4,
  maxBarThickness: 28,
});

export const lineStyle = (theme, color) => ({
  borderColor: color,
  backgroundColor: color,
  borderWidth: 2,
  // Monotone: smooth, but never overshoots below zero or above a peak.
  cubicInterpolationMode: "monotone",
  pointRadius: 0,
  pointHoverRadius: 5,
  pointHoverBorderWidth: 2,
  pointHoverBorderColor: theme.palette.background.paper,
});
