/* @refresh reload */
import "./index.css";
import { enablePopmotion } from "@pathscale/ui/motion";
import { render } from "@solidjs/web";
import { animate } from "popmotion";
import App from "./App";
import { isBlitz } from "./lib/platform";
import { i18n } from "./stores/i18n";

// Without a driver, every @pathscale/ui animation snaps to its end state.
enablePopmotion(animate);

// One AgencyZero token system with a persisted light/dark axis. The preference
// effect supplies `data-color-mode`; `data-theme` remains the stable identity
// @pathscale/ui and Tailwind resolve against.
document.documentElement.setAttribute("data-theme", "agencyzero");
if (isBlitz()) document.documentElement.setAttribute("data-blitz-renderer", "");
void i18n.init();

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element #root not found — check rsbuild's html.mountId.");
}

render(() => <App />, root!);
