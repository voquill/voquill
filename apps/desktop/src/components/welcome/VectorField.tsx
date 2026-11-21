import { useTheme } from "@mui/material";
import chroma from "chroma-js";
import { useEffect, useMemo, useRef } from "react";
import { useWindowSize } from "../../hooks/helper.hooks";
import { useAppStore } from "../../store";
import { getAreAnimationsSuspended } from "../../utils/animation.utils";
import { Perlin } from "../../utils/math.utils";

export const VectorField = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width, height } = useWindowSize();
  const theme = useTheme();
  const suspended = useAppStore(getAreAnimationsSuspended);
  const timeRef = useRef(0);

  // Initialize Perlin noise generator
  const perlin = useMemo(() => new Perlin(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    // Handle high DPI displays
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Configuration
    const GRID_SPACING = 40; // Space between vectors
    const TIME_SPEED = 0.0025; // Speed of animation
    const NOISE_SCALE = 0.0018; // Scale of noise coordinates
    const MAG_SCALE = 0.01; // Scale for magnitude noise
    const MAX_VECTOR_LENGTH = 24; // Maximum length of a vector
    const LINE_WIDTH = 2;

    // Color scale
    // Nice Orange: #FF9F1C, Nice Blue: #3B82F6 (matches web app)
    const colorScale = chroma.scale(["#3B82F6", "#FF9F1C"]).mode("rgb");

    let animationFrameId: number;

    const render = () => {
      timeRef.current += TIME_SPEED;
      const time = timeRef.current;

      // Clear canvas
      ctx.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / GRID_SPACING) + 1;
      const rows = Math.ceil(height / GRID_SPACING) + 1;

      // Center the grid
      const offsetX = (width - (cols - 1) * GRID_SPACING) / 2;
      const offsetY = (height - (rows - 1) * GRID_SPACING) / 2;

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = i * GRID_SPACING + offsetX;
          const y = j * GRID_SPACING + offsetY;

          // Noise 1: Angle
          // Map noise [-1, 1] to angle. Multiplying by PI * 2 allows for full rotation.
          const nAngle = perlin.noise(x * NOISE_SCALE, y * NOISE_SCALE, time);
          const angle = nAngle * Math.PI * 2;

          // Noise 2: Magnitude (offset by large number)
          // Normalize noise from [-1, 1] to [0, 1]
          const rawMag = perlin.noise(
            x * MAG_SCALE + 2000,
            y * MAG_SCALE + 2000,
            time,
          );
          // Map [-1, 1] to [0, 1]
          const magnitude = (rawMag + 1) / 2;

          // Calculate vector length
          const length = magnitude * MAX_VECTOR_LENGTH;

          // Start the line at (x, y)
          const x1 = x;
          const y1 = y;
          const x2 = x + Math.cos(angle) * length;
          const y2 = y + Math.sin(angle) * length;

          // Color based on magnitude
          const color = colorScale(magnitude).hex();

          ctx.strokeStyle = color;
          ctx.lineWidth = LINE_WIDTH;
          ctx.lineCap = "round"; // Makes zero-length lines look like dots
          ctx.globalAlpha = 0.8; // Slight transparency

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      if (!suspended) {
        animationFrameId = requestAnimationFrame(render);
      }
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [width, height, perlin, theme, suspended]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 0, // Will be behind content if content has higher z-index or is stacked on top
        pointerEvents: "none",
      }}
    />
  );
};
