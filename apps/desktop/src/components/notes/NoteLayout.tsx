import { Container, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

/**
 * The column shared by a Notes page and its Ask dock, so both keep the same
 * edges. It stretches across the area beside the sidebar.
 */
export const NoteColumn = ({
  sx,
  children,
}: {
  sx?: SxProps<Theme>;
  children: ReactNode;
}) => (
  <Container
    maxWidth={false}
    sx={[{ px: { xs: 3, md: 5 } }, ...(Array.isArray(sx) ? sx : [sx])]}
  >
    {children}
  </Container>
);

/** An outlined TextField drawn flat: a filled surface with no stroke. */
export const flatFieldSx = {
  "& .MuiOutlinedInput-root": {
    bgcolor: "level1",
    borderRadius: 1,
    transition: "background-color 0.15s ease",
    "&.Mui-focused": { bgcolor: "level2" },
  },
  "& .MuiOutlinedInput-notchedOutline": { border: "none" },
} as const;
