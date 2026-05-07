import { useColorScheme } from "@mui/material";
import { useMemo } from "react";

type BezierCurve = {
  start: { x: number; y: number };
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
  end: { x: number; y: number };
};

const bezierPoint = (curve: BezierCurve, t: number) => {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  const x =
    mt3 * curve.start.x +
    3 * mt2 * t * curve.cp1.x +
    3 * mt * t2 * curve.cp2.x +
    t3 * curve.end.x;
  const y =
    mt3 * curve.start.y +
    3 * mt2 * t * curve.cp1.y +
    3 * mt * t2 * curve.cp2.y +
    t3 * curve.end.y;

  const dx =
    3 * mt2 * (curve.cp1.x - curve.start.x) +
    6 * mt * t * (curve.cp2.x - curve.cp1.x) +
    3 * t2 * (curve.end.x - curve.cp2.x);
  const dy =
    3 * mt2 * (curve.cp1.y - curve.start.y) +
    6 * mt * t * (curve.cp2.y - curve.cp1.y) +
    3 * t2 * (curve.end.y - curve.cp2.y);

  const angle = Math.atan2(dy, dx);
  return { x, y, angle };
};

const sampleWavePoint = (
  curve: BezierCurve,
  t: number,
  frequency: number,
  amplitude: number,
  timeOffset: number,
) => {
  const { x, y, angle } = bezierPoint(curve, t);

  const perpX = -Math.sin(angle);
  const perpY = Math.cos(angle);

  const phase = t * frequency * Math.PI * 2 - timeOffset;
  const sineValue = Math.sin(phase) * amplitude;

  const fadeIn = Math.min(1, t * 5);
  const fadeOut = Math.min(1, (1 - t) * 5);
  const fade = fadeIn * fadeOut;

  return {
    x: x + perpX * sineValue * fade,
    y: y + perpY * sineValue * fade,
  };
};

const generateWavePath = (
  curve: BezierCurve,
  frequency: number,
  amplitude: number,
  timeOffset: number,
  segments: number = 120,
): string => {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    pts.push(
      sampleWavePoint(curve, i / segments, frequency, amplitude, timeOffset),
    );
  }

  const parts: string[] = [`M ${pts[0]!.x} ${pts[0]!.y}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
    const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
    parts.push(`Q ${pts[i]!.x} ${pts[i]!.y} ${mx} ${my}`);
  }
  const last = pts[pts.length - 1]!;
  parts.push(`L ${last.x} ${last.y}`);

  return parts.join(" ");
};

const WAVE_FRAMES = 40;

const WAVE_CONFIGS = [
  { frequency: 2, amplitude: 50, duration: 5.0, opacity: 0.5 },
  { frequency: 3, amplitude: 35, duration: 4.0, opacity: 0.3 },
  { frequency: 5, amplitude: 20, duration: 3.0, opacity: 0.15 },
];

export const TrialEndedBackground = () => {
  const { mode, systemMode } = useColorScheme();
  const isDark = (mode === "system" ? systemMode : mode) === "dark";

  const strokeColor = isDark
    ? "rgba(255, 255, 255, 0.3)"
    : "rgba(0, 0, 0, 0.25)";

  const waves = useMemo(() => {
    const vw = 1000;
    const vh = 1000;

    const curve: BezierCurve = {
      start: { x: -50, y: vh * 0.05 },
      cp1: { x: vw * 0.2, y: vh * 0.95 },
      cp2: { x: vw * 0.8, y: vh * 0.05 },
      end: { x: vw + 50, y: vh * 0.95 },
    };

    return WAVE_CONFIGS.map((config) => {
      const frames: string[] = [];
      for (let i = 0; i < WAVE_FRAMES; i++) {
        const timeOffset = (i / WAVE_FRAMES) * Math.PI * 2;
        frames.push(
          generateWavePath(
            curve,
            config.frequency,
            config.amplitude,
            timeOffset,
          ),
        );
      }
      frames.push(frames[0]!);
      return {
        frames: frames.join(";"),
        opacity: config.opacity,
        duration: config.duration,
      };
    });
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        opacity: 0.5,
      }}
    >
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid slice"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        {waves.map((wave, index) => (
          <path
            key={index}
            fill="none"
            stroke={strokeColor}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: wave.opacity }}
          >
            <animate
              attributeName="d"
              values={wave.frames}
              dur={`${wave.duration}s`}
              repeatCount="indefinite"
            />
          </path>
        ))}
      </svg>
    </div>
  );
};
