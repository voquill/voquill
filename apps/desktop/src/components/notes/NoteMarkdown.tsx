import { Box, Link, Tooltip, type SxProps, type Theme } from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Link targets opened outside the app; everything else renders as text. */
const EXTERNAL_LINK = /^(https?:|mailto:)/i;

const keepExternalLinks = (url: string): string =>
  EXTERNAL_LINK.test(url.trim()) ? url.trim() : "";

/**
 * Note and answer markdown comes from transcripts and pasted text that others
 * can influence, so it never loads anything: images render as their alt
 * text, raw HTML is dropped, and links show their URL and open in the
 * system browser only on click (docs/notes.md "Rendering").
 */
const components: Components = {
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  a: ({ href, children }: ComponentProps<"a">) => {
    if (!href) {
      return <span>{children}</span>;
    }
    return (
      <Tooltip title={href}>
        <Link
          href={href}
          rel="noreferrer noopener"
          onClick={(event) => {
            event.preventDefault();
            void openUrl(href);
          }}
          onAuxClick={(event) => event.preventDefault()}
        >
          {children}
        </Link>
      </Tooltip>
    );
  },
};

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
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={keepExternalLinks}
      components={components}
    >
      {children}
    </Markdown>
  </Box>
);
