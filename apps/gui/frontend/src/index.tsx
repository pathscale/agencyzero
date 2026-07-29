/* @refresh reload */
import "./index.css";
import { enablePopmotion } from "@pathscale/ui/motion";
import { animate } from "popmotion";
import { render } from "solid-js/web";
import App from "./App";

// Without a driver, every @pathscale/ui animation snaps to its end state.
enablePopmotion(animate);

// One theme, always dark: this is a desktop tool with a designed palette, not a
// site that follows the OS.
document.documentElement.setAttribute("data-theme", "agencyzero");

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element #root not found — check rsbuild's html.mountId.");
}

render(() => <App />, root!);
