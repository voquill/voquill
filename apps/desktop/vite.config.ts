import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => {
  const { formatjsOverrideIdFn } = await import("./scripts/formatjs-id.mjs");

  return {
    plugins: [
      react({
        babel: {
          plugins: [
            [
              "babel-plugin-formatjs",
              {
                overrideIdFn: (
                  id: string | undefined,
                  defaultMessage: string | undefined,
                  description: string | undefined,
                  filePath: string | undefined,
                ) =>
                  formatjsOverrideIdFn(
                    id,
                    defaultMessage,
                    description,
                    filePath,
                  ) ?? id,
                ast: true,
              },
            ],
          ],
        },
      }),
      svgr(),
    ],
    clearScreen: false,
    build: {
      rollupOptions: {
        input: ["index.html", "reminders.html"],
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
