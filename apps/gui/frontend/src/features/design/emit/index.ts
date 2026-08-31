/**
 * The emitter registry.
 *
 * H6 asked which of three answers the designer emits, and the answer taken
 * was the third: one IR, both emitters. That decision only costs anything
 * here. Everything upstream of this folder is target-agnostic, and adding a
 * third target is adding a file and a line.
 */

import type { DesignDocument } from "../document";
import { layoutEmitter } from "./layout";
import { tsxEmitter } from "./tsx";
import type { EmitTarget, EmittedFile, Emitter } from "./types";

export type { EmitTarget, EmittedFile, Emitter } from "./types";

export const EMITTERS: readonly Emitter[] = [tsxEmitter, layoutEmitter];

export const DEFAULT_TARGET: EmitTarget = "tsx";

export function emitterFor(target: EmitTarget): Emitter {
  return EMITTERS.find((emitter) => emitter.id === target) ?? tsxEmitter;
}

export function emit(document: DesignDocument, target: EmitTarget): EmittedFile[] {
  return emitterFor(target).emit(document);
}

/** Every file of every target, for a copy-all or a future write-to-disk. */
export function emitAll(document: DesignDocument): Record<EmitTarget, EmittedFile[]> {
  return {
    tsx: tsxEmitter.emit(document),
    layout: layoutEmitter.emit(document),
  };
}
