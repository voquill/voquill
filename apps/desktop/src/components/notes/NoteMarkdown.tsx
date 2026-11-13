import { Box, type SxProps, type Theme } from "@mui/material";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const NoteMarkdown = ({
  children,
  sx,
}: {
  children: string;
  sx?: SxProps<Theme>;
}) => (
  <Box
    sx={[
      {
        typography: "body1",
        overflowWrap: "anywhere",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& h1, & h2": { typography: "h6", fontWeight: 700, mt: 3, mb: 1 },
        "& h3, & h4": {
          typography: "subtitle1",
          fontWeight: 700,
          mt: 2,
          mb: 0.5,
        },
        "& p": { my: 1 },
        "& ul, & ol": { my: 1, pl: 3 },
        "& li": { my: 0.25 },
        "& li.task-list-item": { listStyle: "none", ml: -3 },
        "& input[type=checkbox]": { mr: 1, verticalAlign: "middle" },
        "& a": { color: "primary.main" },
        "& pre": {
          my: 1,
          p: 1,
          borderRadius: 1,
          bgcolor: "action.selected",
          overflow: "auto",
        },
        "& code": { fontSize: "0.85em" },
        "& blockquote": {
          m: 0,
          my: 1,
          pl: 2,
          borderLeft: 3,
          borderColor: "divider",
          color: "text.secondary",
        },
        "& table": { borderCollapse: "collapse", my: 1, width: "100%" },
        "& th, & td": {
          border: 1,
          borderColor: "divider",
          px: 1,
          py: 0.5,
          textAlign: "left",
        },
        "& th": { bgcolor: "action.selected", fontWeight: 600 },
      },
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
  >
    <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
  </Box>
);
