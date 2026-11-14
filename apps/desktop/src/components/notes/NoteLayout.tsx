import { Container, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

/** The open note fills the window, so its column is wider than the dashboard's but keeps a readable line length. */
const NOTE_PAGE_MAX_WIDTH = 728;

export type NoteColumnScope = "list" | "note";

/** The centred column shared by a page's content and its Ask dock, so both keep the same edges. */
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
      scope === "note" && { maxWidth: NOTE_PAGE_MAX_WIDTH },
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
