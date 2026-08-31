/** The contract both emitters satisfy, so the source pane knows neither one. */

import type { DesignDocument } from "../document";

export type EmitTarget = "tsx" | "layout";

export type EmittedFile = {
  /** Filename as it would land on disk, relative to the component's folder. */
  path: string;
  language: "tsx" | "ts";
  source: string;
};

export type Emitter = {
  id: EmitTarget;
  label: string;
  summary: string;
  /**
   * One document in, the files that represent it out.
   *
   * Plural because a solid-layouts component is a template *and* a recipe;
   * a single-file signature would have forced the layout emitter to inline
   * the recipe and stop matching the toolchain it exists to match.
   */
  emit(document: DesignDocument): EmittedFile[];
};
