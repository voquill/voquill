import { Box, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

type TranscriptionTextBlockProps = {
  label: React.ReactNode;
  value: string | null | undefined;
  placeholder?: React.ReactNode;
  monospace?: boolean;
};

export const TranscriptionTextBlock = ({
  label,
  value,
  placeholder,
  monospace,
}: TranscriptionTextBlockProps) => {
  const normalized = value?.trim();

  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {normalized ? (
        <Box
          sx={(theme) => ({
            mt: 0.5,
            p: 1,
            borderRadius: 1,
            bgcolor:
              theme.vars?.palette.level1 ?? theme.palette.background.default,
          })}
        >
          <Typography
            variant="body2"
            sx={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: monospace ? '"Roboto Mono", monospace' : undefined,
            }}
          >
            {normalized}
          </Typography>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {placeholder ?? <FormattedMessage defaultMessage="Not provided." />}
        </Typography>
      )}
    </Box>
  );
};
