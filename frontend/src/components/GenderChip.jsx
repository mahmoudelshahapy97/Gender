import Chip from "@mui/material/Chip";
import { GENDER_COLOR, GENDER_LABEL } from "../utils/constants";

/** A visit's or a tracked person's label, in that label's chart colour. */
export function GenderChip({ gender, size = "small", suffix }) {
  const color = GENDER_COLOR[gender] || GENDER_COLOR.unknown;
  return (
    <Chip
      size={size}
      label={`${GENDER_LABEL[gender] || gender}${suffix ? ` ${suffix}` : ""}`}
      sx={{ bgcolor: `${color}26`, color, fontWeight: 600, border: `1px solid ${color}66` }}
    />
  );
}

export default GenderChip;
