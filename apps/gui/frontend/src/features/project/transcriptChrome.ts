import { createSignal } from "solid-js";

/*
 * Anything below the transcript that changes height, announced.
 *
 * The transcript is a flex child above a footer that grows and shrinks: PR
 * chips, a queued compaction, held prompts, the cost warning, the composer's
 * own modes. When the footer grows the scroller gets shorter, and a transcript
 * following its tail has to be put back on it or the newest message is left
 * half-cut under the chrome — "dialogs are not pushing the chat up".
 *
 * A `ResizeObserver` would be the natural way to notice, and `TranscriptPane`
 * asks for one. **Blitz implements neither `ResizeObserver` nor
 * `MutationObserver`**, and both calls sit behind `typeof … !== "undefined"`
 * guards, so both paths have been dead the whole time and failed silently.
 * Until the engine grows them, the chrome says so explicitly.
 *
 * Its own module, and deliberately a leaf: the announcers are the components
 * that change height, and half of them sit below `TranscriptPane` in the import
 * graph. Exporting the signal from the pane itself made the composer import the
 * whole transcript to say one word.
 */
const [chromeRevision, bumpChromeRevision] = createSignal(0);

export { chromeRevision };

export function noteTranscriptChromeChanged(): void {
  bumpChromeRevision((value) => value + 1);
}
