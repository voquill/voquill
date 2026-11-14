import { Container, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

export type NoteColumnScope = "list" | "note";

/**
 * The column shared by a page's content and its Ask dock, so both keep the
 * same edges. The list is a centred column like the other dashboard pages; an
 * open note stretches to the edges of the area beside the sidebar.
 */
export const NoteColumn = ({
  scope,
  sx,
  children,
}: {
  scope: NoteColumnScope;
  sx?: SxProps<Theme>;
  children: ReactNode;
}) => (
  <Container
    maxWidth={scope === "list" ? "sm" : false}
    sx={[
      scope === "note" && { px: { xs: 3, md: 5 } },
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
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
