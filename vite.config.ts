import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The shared MCP tool table. It cannot live under `src/`: it also ships as
      // a bundle resource next to `scripts/mcp/server.mjs`, which runs in a
      // bare node process with no `node_modules` beside it. An alias keeps the
      // app-side import non-relative, which is what `scripts/check-imports.mjs`
      // requires of anything crossing a module boundary.
      "@mcp": path.resolve(__dirname, "./scripts/mcp"),
    },
  },
  esbuild: {
    drop: mode === "production" ? (["debugger"] as ["debugger"]) : [],
    pure: mode === "production" ? ["console.debug", "console.info", "console.trace"] : [],
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "es2020",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        settings: path.resolve(__dirname, "settings.html"),
        debug: path.resolve(__dirname, "debug.html"),
        float: path.resolve(__dirname, "float.html"),
      },
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;

          // clsx / tailwind-merge / cva are tiny class-name utils that `cn` and
          // every shadcn UI primitive use, so they're imported by nearly all of
          // the eager chrome. Pin them to their own chunk: streamdown ALSO
          // depends on clsx + tailwind-merge, so without this rule rolldown
          // folded them into the large (lazy) streamdown chunk - and the eager
          // UI's clsx import then dragged the whole ~479KB streamdown chunk onto
          // first paint. Their own tiny eager chunk keeps streamdown lazy.
          if (
            id.includes("/clsx/") ||
            id.includes("/tailwind-merge/") ||
            id.includes("/class-variance-authority/")
          )
            return "ui-utils";

          // Each AI provider SDK in its own chunk so unused providers
          // don't bloat the initial load (lazy-imported in agent.ts).
          if (id.includes("@ai-sdk/anthropic")) return "ai-anthropic";
          if (id.includes("@ai-sdk/google")) return "ai-google";
          if (id.includes("@ai-sdk/openai-compatible")) return "ai-openai-compat";
          if (id.includes("@ai-sdk/openai")) return "ai-openai";
          if (id.includes("@ai-sdk/cerebras")) return "ai-cerebras";
          if (id.includes("@ai-sdk/groq")) return "ai-groq";
          if (id.includes("@ai-sdk/xai")) return "ai-xai";
          if (id.includes("@ai-sdk/")) return "ai-sdk-shared";

          if (id.includes("/xterm/") || id.includes("@xterm/")) return "xterm";
          // Per-language grammars and the legacy stream parsers are dynamically
          // imported by the chat code renderer (chat-code-lezer.ts). Let
          // Rollup auto-split them so they load lazily - otherwise the
          // broad codemirror rule below would suck them into the eager chunk.
          if (id.includes("@codemirror/lang-") || id.includes("@codemirror/legacy-modes")) return;
          // Themes are also lazy-loaded by EditorPane / AiDiffPane / GitDiffPane.
          if (id.includes("@uiw/codemirror-theme-")) return;
          if (
            id.includes("@codemirror/") ||
            id.includes("@uiw/codemirror") ||
            id.includes("@replit/codemirror")
          )
            return "codemirror";
          // streamdown is deliberately NOT a manual chunk. It is used only by
          // lazy surfaces (the AI chat renderer, the editor markdown preview),
          // so letting rolldown auto-split it keeps the ~479KB library in a
          // lazy chunk. Pinning it to a named chunk pulled the injected runtime
          // helpers (_defineProperty / __vitePreload) and its bundled clsx +
          // tailwind-merge into that named chunk, which every eager chunk then
          // imported - dragging the whole library onto first paint.
          if (id.includes("/motion/") || id.includes("framer-motion")) return "motion";
          if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("/scheduler/"))
            return "react";
          if (id.includes("@radix-ui/") || id.includes("/radix-ui/")) return "radix";
        },
      },
    },
  },
  clearScreen: false,
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
      // `scripts/**` is outside the app's module graph, and a write there while
      // `scripts/mcp` is driving the window must not reload it mid-task.
      ignored: ["**/src-tauri/**", "**/scripts/**"],
    },
  },
}));
