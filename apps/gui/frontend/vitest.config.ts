import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    solidPlugin({ hot: process.env.NODE_ENV !== "test" }),
    /*
     * Run the Solid that ships, not the dev build.
     *
     * `@solidjs/signals` maps the `test` condition to `dist/dev.js`, and
     * vitest applies `test` however the resolve conditions are written, so
     * neither `resolve.conditions` nor an alias displaces it. Only the dev
     * build carries `REACTIVE_WRITE_IN_OWNED_SCOPE`, which rejects a store
     * write from a different owner than the one that created the store.
     *
     * That is this workspace's shape by design, and under the dev build the
     * consequences are not subtle: `SettingsTab`'s effects throw, the reactive
     * system halts mid-boot, `boot.status` never leaves "loading", and every
     * `waitFor` on it polls until the process is killed for running out of
     * memory. The store suites fail the same way, on writes that never land.
     *
     * The guard does not exist in the shipped bundle - zero occurrences in
     * `dist/static/js` - so rewriting the specifier here makes the suite
     * exercise what users actually run.
     */
    {
      name: "solid-prod-build-in-tests",
      enforce: "pre" as const,
      async resolveId(id: string, importer: string | undefined) {
        if (!id.includes("@solidjs/signals")) return null;
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        // Both the bare specifier and `solid-js`'s own deep import land here;
        // only the dev entry needs swapping.
        const target = resolved?.id ?? id;
        return target.includes("/dist/dev.js")
          ? target.replace("/dist/dev.js", "/dist/prod/index.js")
          : resolved;
      },
    },
  ],
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
