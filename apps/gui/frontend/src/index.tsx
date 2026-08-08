/* @refresh reload */
import "./index.css";
import { enablePopmotion } from "@pathscale/ui/motion";
import { animate } from "popmotion";
import { render } from "solid-js/web";
import App from "./App";
import { i18n } from "./stores/i18n";

// Without a driver, every @pathscale/ui animation snaps to its end state.
enablePopmotion(animate);

// AgencyZero owns the token system; third-party controls still need the
// conventional light/dark theme name. The preference effect keeps `data-theme`
// and `data-color-mode` in sync, while this stable attribute scopes our CSS.
document.documentElement.setAttribute("data-agency-theme", "agencyzero");
document.documentElement.setAttribute("data-theme", "dark");
void i18n.init();

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element #root not found — check rsbuild's html.mountId.");
}

render(() => <App />, root!);
