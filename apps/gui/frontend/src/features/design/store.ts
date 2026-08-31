/**
 * Designer state: one document, one selection, one emit target, one history.
 *
 * A module singleton rather than a context, matching `stores/prefs.ts`. The
 * Design tab is a single tab and the palette, canvas, inspector and source
 * pane are four views of the same document; threading a context through them
 * would buy isolation nothing here wants.
 *
 * Every mutation goes through `commit`, which is also the only place history
 * is recorded. That is deliberate: undo is a designer's most-used control,
 * and a store where some edits bypass it is worse than one with no undo.
 */

import { createMemo, createSignal } from "solid-js";
import type { CatalogEntry, PropValue } from "./catalog";
import { appendToRoot, applyDrop, type DragSource, type DropPlan } from "./dnd";
import {
  type DesignDocument,
  type DesignNode,
  emptyDocument,
  findNode,
  ROOT_ID,
  remove,
  rename,
  setProp,
  setText,
} from "./document";
import { DEFAULT_TARGET, type EmitTarget, type EmittedFile, emit } from "./emit";

const HISTORY_LIMIT = 100;

const [document, setDocument] = createSignal<DesignDocument>(emptyDocument());
const [selectedId, setSelectedId] = createSignal<string>(ROOT_ID);
const [target, setTarget] = createSignal<EmitTarget>(DEFAULT_TARGET);
const [dragging, setDragging] = createSignal<DragSource | null>(null);
const [dropPlan, setDropPlan] = createSignal<DropPlan | null>(null);

let past: DesignDocument[] = [];
let future: DesignDocument[] = [];
const [historyDepth, setHistoryDepth] = createSignal({ past: 0, future: 0 });

function commit(next: DesignDocument): void {
  const current = document();
  if (next === current) return;
  past = [...past.slice(-(HISTORY_LIMIT - 1)), current];
  future = [];
  setDocument(next);
  setHistoryDepth({ past: past.length, future: 0 });
}

/**
 * The emitted files for the selected target.
 *
 * A memo, so the source pane re-renders on an edit and on a target switch
 * and at no other time. Emission is cheap, but it is also the deliverable,
 * and recomputing it on every pointer move during a drag would be the first
 * thing to blame when the canvas felt heavy.
 */
const emitted = createMemo<EmittedFile[]>(() => emit(document(), target()));

const selectedNode = createMemo<DesignNode | null>(() => findNode(document(), selectedId()));

export const design = {
  document,
  selectedId,
  selectedNode,
  target,
  dragging,
  dropPlan,
  emitted,
  history: historyDepth,

  select(id: string): void {
    setSelectedId(id);
  },

  setTarget(next: EmitTarget): void {
    setTarget(next);
  },

  /** Palette click-to-add: append to the artboard and select what landed. */
  add(entry: CatalogEntry): void {
    const result = appendToRoot(document(), entry);
    commit(result.document);
    setSelectedId(result.selectedId);
  },

  beginDrag(source: DragSource): void {
    setDragging(source);
    setDropPlan(null);
  },

  hover(plan: DropPlan | null): void {
    setDropPlan(plan);
  },

  /** Finish a drag. A drop with no resolved plan cancels rather than guesses. */
  endDrag(): void {
    const source = dragging();
    const plan = dropPlan();
    setDragging(null);
    setDropPlan(null);
    if (!source || !plan) return;
    const result = applyDrop(document(), source, plan);
    commit(result.document);
    setSelectedId(result.selectedId);
  },

  cancelDrag(): void {
    setDragging(null);
    setDropPlan(null);
  },

  setProp(id: string, name: string, value: PropValue | undefined): void {
    commit(setProp(document(), id, name, value));
  },

  setText(id: string, text: string): void {
    commit(setText(document(), id, text));
  },

  rename(name: string): void {
    commit(rename(document(), name));
  },

  remove(id: string): void {
    if (id === ROOT_ID) return;
    commit(remove(document(), id));
    setSelectedId(ROOT_ID);
  },

  clear(): void {
    commit(emptyDocument(document().name));
    setSelectedId(ROOT_ID);
  },

  undo(): void {
    const previous = past.at(-1);
    if (!previous) return;
    past = past.slice(0, -1);
    future = [document(), ...future].slice(0, HISTORY_LIMIT);
    setDocument(previous);
    setHistoryDepth({ past: past.length, future: future.length });
    if (!findNode(previous, selectedId())) setSelectedId(ROOT_ID);
  },

  redo(): void {
    const next = future[0];
    if (!next) return;
    future = future.slice(1);
    past = [...past, document()];
    setDocument(next);
    setHistoryDepth({ past: past.length, future: future.length });
    if (!findNode(next, selectedId())) setSelectedId(ROOT_ID);
  },
};

/** Only for tests: put the designer back to an empty artboard with no history. */
export function resetDesignStore(): void {
  past = [];
  future = [];
  setHistoryDepth({ past: 0, future: 0 });
  setDocument(emptyDocument());
  setSelectedId(ROOT_ID);
  setTarget(DEFAULT_TARGET);
  setDragging(null);
  setDropPlan(null);
}
