import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import { resolve } from "node:path";
import { pluginSolidLayoutsApplication } from "rsbuild-plugin-solid-layouts";

const localUiDist = process.env.AZ_UI_DIST;
const localUiRoot = localUiDist ? resolve(localUiDist, "../..") : undefined;
const packageVersion = async (name: string) =>
  ((await Bun.file(resolve(__dirname, "node_modules", name, "package.json")).json()) as {
    version: string;
  }).version;
const solidVersion = await packageVersion("solid-js");
const solidWebVersion = await packageVersion("@solidjs/web");

if (localUiDist && localUiRoot) {
  for (const required of [
    localUiDist,
    resolve(localUiRoot, "package.json"),
    resolve(localUiRoot, "dist", "layouts.manifest.json"),
  ]) {
    if (!(await Bun.file(required).exists())) {
      throw new Error(`AZ_UI_DIST dependency is incomplete: ${required} does not exist`);
    }
  }
}

if (solidVersion !== solidWebVersion || !solidVersion.startsWith("2.")) {
  throw new Error(
    `AZ requires one matching Solid 2 runtime; resolved solid-js=${solidVersion}, @solidjs/web=${solidWebVersion}`,
  );
}

export default defineConfig({
  plugins: [
    // Must run before Babel and Solid. Once the Solid JSX transform has run
    // there is no <Button> left to resolve against the Layout manifest, only
    // _$createComponent calls.
    pluginSolidLayoutsApplication({
      layouts: localUiDist
        ? [{ module: "@pathscale/ui", root: localUiRoot! }]
        : ["@pathscale/ui"],
    }),
    pluginBabel({ include: /\.(?:jsx|tsx|ts)$/ }),
    pluginSolid({ solidPresetOptions: { moduleName: "@solidjs/web" } }),
  ],
  resolve: {
    alias: {
      "~": "./src",
      ...(localUiDist
        ? {
            "@pathscale/ui": localUiDist,
            // Aliasing a conditional-export package to its directory bypasses
            // its `browser` condition and falls through to `main`, which is
            // Solid's server runtime. The resulting bundle compiles cleanly
            // and then throws from `render` before the first component mounts.
            // Point at the browser entries explicitly while still forcing UI
            // and AZ through the same physical Solid 2 installation.
            "@solidjs/web": resolve(
              __dirname,
              "node_modules/@solidjs/web/dist/web.js",
            ),
            "solid-js": resolve(__dirname, "node_modules/solid-js/dist/solid.js"),
          }
        : {}),
    },
  },
  html: {
    tags: [{ tag: "meta", attrs: { charset: "utf-8" }, head: true, prepend: true }],
    meta: {
      viewport: "width=device-width, initial-scale=1",
      "theme-color": "#ffee58",
    },
    title: "AgencyZero",
    mountId: "root",
  },
  dev: {
    hmr: true,
    liveReload: true,
  },
  server: {
    port: 3010,
  },
  tools: {
    rspack: {
      optimization: {
        splitChunks: false,
        runtimeChunk: false,
      },
      plugins: localUiDist
        ? []
        : [
            new ForkTsCheckerWebpackPlugin({
              typescript: { configFile: "./tsconfig.json" },
            }),
          ],
    },
  },
  output: {
    // Tauri serves this directory (tauri.conf.json -> build.frontendDist).
    distPath: { root: "../dist" },
    // Rsbuild refuses to empty a dist outside its root unless told to, and a
    // stale hashed bundle left behind is what ships in the next .app.
    cleanDistPath: true,
    // The webview loads from tauri://localhost, so assets must resolve relatively.
    assetPrefix: "./",
    inlineStyles: false,
    legalComments: "none",
  },
});
