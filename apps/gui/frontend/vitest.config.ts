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
    alias: { "~": resolve(__dirname, "./src") },
    conditions: ["browser", "import", "module", "default"],
  },
});
