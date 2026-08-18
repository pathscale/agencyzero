import { describeError, log } from "~/lib/log";

/**
 * Open the OS picker and hand back the paths, or report why it could not.
 *
 * Shared because the composer and Home's task manager both attach files, and
 * both used to own a copy of this: the same `catch`, the same log line and the
 * same sentence written twice, with a comment in one pointing at the other.
 *
 * The error is returned rather than thrown so each caller can put it where its
 * own surface shows errors, which is the only part that genuinely differs -
 * one writes a bare signal, the other writes into a per-tab bucket.
 *
 * Saying so on the surface matters and is why this exists at all: the handlers
 * used to warn and return, so a picker that failed to open was
 * indistinguishable from one the owner cancelled. The button appeared to do
 * nothing, and the only trace was a console nobody has open.
 */
export async function chooseAttachmentPaths(
  choose: () => Promise<string[]>,
): Promise<{ paths: string[]; error: string | null }> {
  try {
    return { paths: await choose(), error: null };
  } catch (cause) {
    const detail = describeError(cause);
    log.warn(`could not attach: ${detail}`);
    return { paths: [], error: `Could not attach a file. ${detail}` };
  }
}
