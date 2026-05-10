import { LoadingButton } from "@mui/lab";
import { Alert, Box, Button, Stack, useTheme } from "@mui/material";
import { Nullable } from "@voquill/types";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { cleanupAudioFile } from "../../utils/audio.utils";
import { AudioWaveform } from "../common/AudioWaveform";

type StopRecordingResponse = {
  filePath: string;
  sampleRate: number;
  sampleCount: number;
};

const createPreviewUrl = (filePath: string): string | null => {
  if (!filePath) return null;
  return convertFileSrc(filePath);
};

export type MicrophoneTesterProps = {
  preferredMicrophone: Nullable<string>;
  waveformHeight?: number;
  disabled?: boolean;
  buttonLayout?: "row" | "column";
  fadeColor?: string;
  justifyButtons?: "flex-start" | "center" | "flex-end" | "space-between";
};

export const MicrophoneTester = ({
  preferredMicrophone,
  waveformHeight = 96,
  disabled = false,
  buttonLayout = "row",
  fadeColor = "level0",
  justifyButtons = "flex-start",
}: MicrophoneTesterProps) => {
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const audioLevels = useAppStore((state) => state.audioLevels);
  const theme = useTheme();
  const effectiveFadeColor =
    fadeColor === "level0"
      ? theme.vars?.palette.level0
      : theme.vars?.palette?.level1;

  const [testState, setTestState] = useState<
    "idle" | "starting" | "recording" | "stopping"
  >("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const isGlobalRecording =
    overlayPhase === "recording" || overlayPhase === "loading";
  const isTestRunning = testState === "recording";
  const isTestLoading = testState === "starting";
  const isTestStopping = testState === "stopping";

  const releasePreviewAudio = useCallback(() => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      previewAudioRef.current = null;
    }
    setIsPreviewPlaying(false);
  }, []);

  const clearPreviewUrl = useCallback(() => {
    releasePreviewAudio();
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, [releasePreviewAudio]);

  const updatePreviewUrl = useCallback(
    (url: string | null) => {
      releasePreviewAudio();
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = url;
      setPreviewUrl(url);
    },
    [releasePreviewAudio],
  );

  useEffect(() => () => clearPreviewUrl(), [clearPreviewUrl]);

  useEffect(() => {
    if (!previewUrl) {
      setIsPreviewPlaying(false);
      return;
    }

    const audio = new Audio(previewUrl);
    audio.preload = "auto";

    const handlePlay = () => setIsPreviewPlaying(true);
    const handlePause = () => setIsPreviewPlaying(false);
    const handleEnded = () => setIsPreviewPlaying(false);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    previewAudioRef.current = audio;

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
      }
    };
  }, [previewUrl]);

  const handleStartTest = useCallback(async () => {
    if (isTestRunning || isTestLoading || isGlobalRecording || disabled) {
      return;
    }

    setTestError(null);
    clearPreviewUrl();
    setTestState("starting");

    try {
      await invoke<void>("start_recording", {
        args: { preferredMicrophone: preferredMicrophone ?? null },
      });
      setTestState("recording");
    } catch (error) {
      console.error("Failed to start microphone test", error);
      setTestError("Unable to start microphone test. Please try again.");
      setTestState("idle");
    }
  }, [
    clearPreviewUrl,
    disabled,
    isGlobalRecording,
    isTestLoading,
    isTestRunning,
    preferredMicrophone,
  ]);

  const handleStopTest = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (testState !== "recording" && testState !== "starting") {
        return;
      }

      setTestState("stopping");

      try {
        const response = await invoke<StopRecordingResponse>("stop_recording");
        const rate = response.sampleRate ?? 0;

        if (!opts?.silent) {
          if (response.filePath && rate > 0 && response.sampleCount > 0) {
            const url = createPreviewUrl(response.filePath);
            updatePreviewUrl(url);
          } else {
            updatePreviewUrl(null);
            setTestError(
              "We didn't detect any audio. Try speaking while the test is running.",
            );
          }
        } else {
          updatePreviewUrl(null);
        }

        // Clean up temp recording file (preview URL uses asset protocol, not a blob)
        if (response.filePath) {
          cleanupAudioFile(response.filePath);
        }
      } catch (error) {
        console.error("Failed to stop microphone test", error);
        if (!opts?.silent) {
          setTestError("Unable to stop microphone test. Please try again.");
        }
      } finally {
        setTestState("idle");
        produceAppState((draft) => {
          draft.audioLevels = [];
        });
      }
    },
    [testState, updatePreviewUrl],
  );

  const handleTogglePreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (!audio) {
      return;
    }

    if (!audio.paused && !audio.ended) {
      audio.pause();
      return;
    }

    audio
      .play()
      .then(() => {
        setTestError(null);
        setIsPreviewPlaying(true);
      })
      .catch((error) => {
        console.error("Failed to play recorded preview", error);
        setTestError("Unable to play the recorded preview.");
        setIsPreviewPlaying(false);
      });
  }, []);

  useEffect(() => {
    if (
      (testState === "recording" || testState === "starting") &&
      isGlobalRecording
    ) {
      void handleStopTest({ silent: true });
    }
  }, [handleStopTest, isGlobalRecording, testState]);

  const handleStopTestRef = useRef(handleStopTest);
  useEffect(() => {
    handleStopTestRef.current = handleStopTest;
  }, [handleStopTest]);

  useEffect(() => {
    return () => {
      void handleStopTestRef.current({ silent: true });
      clearPreviewUrl();
    };
  }, [clearPreviewUrl]);

  const disableStartButton =
    disabled || isGlobalRecording || isTestLoading || isTestRunning;
  const disableStopButton = disabled || isTestStopping;

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          position: "relative",
          width: "100%",
          height: waveformHeight,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
        }}
      >
        <AudioWaveform
          levels={audioLevels}
          active={isTestRunning}
          processing={isTestLoading || isTestStopping}
          style={{ width: "100%", height: "100%" }}
        />
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `linear-gradient(90deg, ${effectiveFadeColor} 0%, transparent 18%, transparent 82%, ${effectiveFadeColor} 100%)`,
          }}
        />
      </Box>

      <Stack
        direction={buttonLayout}
        spacing={1.5}
        alignItems={buttonLayout === "row" ? "center" : "stretch"}
        width="100%"
        justifyContent={justifyButtons}
      >
        <LoadingButton
          variant={isTestRunning ? "outlined" : "contained"}
          color={isTestRunning ? "error" : "primary"}
          onClick={
            isTestRunning ? () => void handleStopTest() : handleStartTest
          }
          loading={isTestLoading || isTestStopping}
          disabled={isTestRunning ? disableStopButton : disableStartButton}
          fullWidth={buttonLayout === "column"}
        >
          {isTestRunning ? (
            <FormattedMessage defaultMessage="Finish" />
          ) : (
            <FormattedMessage defaultMessage="Record" />
          )}
        </LoadingButton>
        <Button
          variant="outlined"
          disabled={previewUrl == null || disabled}
          onClick={handleTogglePreview}
          fullWidth={buttonLayout === "column"}
        >
          {isPreviewPlaying ? (
            <FormattedMessage defaultMessage="Pause" />
          ) : (
            <FormattedMessage defaultMessage="Play" />
          )}
        </Button>
      </Stack>

      {isGlobalRecording && (
        <Alert severity="info">
          <FormattedMessage defaultMessage="You cannot start a microphone test while a transcription is in progress." />
        </Alert>
      )}

      {testError && (
        <Alert severity="warning" onClose={() => setTestError(null)}>
          {testError}
        </Alert>
      )}
    </Stack>
  );
};
