import { isPromptSyntaxDirectiveLine } from "~/features/project/promptSyntax";

/** Hide a partial or complete authoring directive while it is the live tail. */
export function holdBackPartialDirective(text: string): string {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = lineStart === 0 ? text : text.slice(lineStart);
  const openInLine = line.lastIndexOf("<ps");
  if (openInLine === -1) return text;

  const open = lineStart + openInLine;
  const closed = text.indexOf(">", open);
  if (closed === -1) return text.slice(0, open);
  return isPromptSyntaxDirectiveLine(line) ? text.slice(0, lineStart) : text;
}

export const TRANSCRIPT_PAGE_SIZE = 12;
export const TRANSCRIPT_MAX_ENTRIES = TRANSCRIPT_PAGE_SIZE * 4;

export function transcriptTail<T>(
  entries: T[],
  visibleCount: number,
  trailingHidden = 0,
): { hidden: number; trailing: number; visible: T[] } {
  const size = Math.min(Math.max(1, visibleCount), TRANSCRIPT_MAX_ENTRIES);
  const trailing = Math.max(0, Math.min(trailingHidden, entries.length - size));
  const end = entries.length - trailing;
  const hidden = Math.max(0, end - size);
  return { hidden, trailing, visible: entries.slice(hidden, end) };
}

export function shouldRevealEarlier(
  scrollTop: number,
  hidden: number,
  ownerIntent: boolean,
): boolean {
  return ownerIntent && hidden > 0 && scrollTop <= 48;
}

export function shouldRevealLater(
  distanceToTail: number,
  trailing: number,
  ownerIntent: boolean,
): boolean {
  return ownerIntent && trailing > 0 && distanceToTail <= 48;
}

export function anchoredScrollTop(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

export function anchoredToRow(currentTop: number, previousGap: number, nextGap: number): number {
  return Math.max(0, currentTop + nextGap - previousGap);
}
