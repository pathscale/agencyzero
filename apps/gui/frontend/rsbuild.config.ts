import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";

export default defineConfig({
  plugins: [pluginBabel({ include: /\.(?:jsx|tsx|ts)$/ }), pluginSolid()],
  resolve: {
    alias: {
      "~": "./src",
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
      plugins: [
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
