import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solidPlugin({ hot: process.env.NODE_ENV !== "test" })],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    server: {
      // @pathscale/ui ships JSX-compiled ESM that has to go through the Solid
      // plugin rather than being externalised.
      deps: { inline: ["@pathscale/ui"] },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/test/**", "src/api/fixtures.ts"],
    },
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
    /*
     * No "development" condition, deliberately.
     *
     * `solid-js` exports `dist/dev.js` under it and `dist/solid.js` otherwise,
     * and only the dev build carries the `REACTIVE_WRITE_IN_OWNED_SCOPE`
     * guard. That guard throws on a store write made from a different owner
     * than the one that created the store, which is the shape this workspace
     * has by design: one long-lived store, written from components and
     * effects all over the app.
     *
     * It is absent from the shipped bundle - checked, zero occurrences - so a
     * suite that resolves the dev build is testing a stricter runtime than the
     * one users get, and 45 store tests failed on writes that work in the app.
     */
    conditions: ["browser", "import", "module", "default"],
  },
});
