import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Vitest replaces every .css import with an empty string, `?raw` included.
    // The per-template compiler reads Tailwind's own stylesheets that way, so
    // those (and only those) must come through intact.
    css: { include: [/\/tailwindcss\/(theme|preflight|utilities)\.css/] },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
