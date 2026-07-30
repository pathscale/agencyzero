import type { JSX } from "solid-js";

/**
 * The icon set, inlined.
 *
 * The design's hard rule is "no network at runtime: all icons are inlined SVG
 * symbols" (`design/README.md`), so these paths are transcribed from the
 * mockup's own sprite rather than pulled from an icon package at build time.
 * Mount {@link IconSprite} once at the app root; everything else references a
 * symbol through `<Icon name="…" />`.
 */
export type IconName =
  | "arrow-up"
  | "check"
  | "copy"
  | "pencil"
  | "terminal"
  | "gauge"
  | "chevron-down"
  | "chevron-up"
  | "chevron-right"
  | "ellipsis-vertical"
  | "file-plus-2"
  | "folder"
  | "folder-plus"
  | "folder-git-2"
  | "git-pull-request"
  | "git-merge"
  | "history"
  | "info"
  | "layout-grid"
  | "list-checks"
  | "lock"
  | "message-square-dashed"
  | "messages-square"
  | "mic"
  | "pause"
  | "pin"
  | "play"
  | "plus"
  | "search"
  | "settings"
  | "shield"
  | "sliders-horizontal"
  | "sparkles"
  | "square"
  | "x";

export function IconSprite(): JSX.Element {
  return (
    <svg aria-hidden="true" width="0" height="0" class="absolute size-0 overflow-hidden">
      <title>Icon sprite</title>
      <symbol id="i-arrow-up" viewBox="0 0 24 24">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 24 24">
        <path d="M20 6 9 17l-5-5" />
      </symbol>
      <symbol id="i-chevron-down" viewBox="0 0 24 24">
        <path d="m6 9 6 6 6-6" />
      </symbol>
      <symbol id="i-chevron-up" viewBox="0 0 24 24">
        <path d="m18 15-6-6-6 6" />
      </symbol>
      <symbol id="i-chevron-right" viewBox="0 0 24 24">
        <path d="m9 18 6-6-6-6" />
      </symbol>
      <symbol id="i-ellipsis-vertical" viewBox="0 0 24 24">
        <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-file-plus-2" viewBox="0 0 24 24">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M12 12v5M9.5 14.5h5" />
      </symbol>
      <symbol id="i-folder" viewBox="0 0 24 24">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </symbol>
      <symbol id="i-folder-plus" viewBox="0 0 24 24">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M12 11v6M9 14h6" />
      </symbol>
      <symbol id="i-folder-git-2" viewBox="0 0 24 24">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <circle cx="13" cy="13" r="1.8" />
      </symbol>
      <symbol id="i-git-pull-request" viewBox="0 0 24 24">
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="18" r="3" />
        <path d="M6 9v6" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      </symbol>
      <symbol id="i-git-merge" viewBox="0 0 24 24">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </symbol>
      <symbol id="i-history" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </symbol>
      <symbol id="i-info" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-copy" viewBox="0 0 24 24">
        <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
        <path d="M5.5 15H4.8A1.3 1.3 0 0 1 3.5 13.7V4.8A1.3 1.3 0 0 1 4.8 3.5h8.9A1.3 1.3 0 0 1 15 4.8v.7" />
      </symbol>
      <symbol id="i-terminal" viewBox="0 0 24 24">
        <path d="m4.5 6.5 5 5-5 5" />
        <path d="M12 17.5h7.5" />
      </symbol>
      <symbol id="i-gauge" viewBox="0 0 24 24">
        <path d="M12 14.5 15.5 9" />
        <path d="M4 18a9 9 0 1 1 16 0" />
      </symbol>
      <symbol id="i-pencil" viewBox="0 0 24 24">
        <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
        <path d="m14.5 6.5 3 3" />
      </symbol>
      <symbol id="i-layout-grid" viewBox="0 0 24 24">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </symbol>
      <symbol id="i-list-checks" viewBox="0 0 24 24">
        <path d="M11 6h9M11 12h9M11 18h9" />
        <path d="m3 6 1.6 1.6L7.4 4.8" />
        <path d="m3 12.5 1.6 1.6 2.8-2.8" />
      </symbol>
      <symbol id="i-lock" viewBox="0 0 24 24">
        <rect x="4.5" y="11" width="15" height="9.5" rx="2" />
        <path d="M8 11V7.8a4 4 0 0 1 8 0V11" />
      </symbol>
      <symbol id="i-message-square-dashed" viewBox="0 0 24 24">
        <rect x="3.5" y="4" width="17" height="13" rx="3" stroke-dasharray="3.5 3" />
        <path d="M8 17v3.5L12.5 17" />
      </symbol>
      <symbol id="i-messages-square" viewBox="0 0 24 24">
        <path d="M4.5 5.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.5L5 18V5.5z" />
      </symbol>
      <symbol id="i-mic" viewBox="0 0 24 24">
        <rect x="9" y="2.8" width="6" height="11.4" rx="3" />
        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
        <path d="M12 18v3.2" />
      </symbol>
      <symbol id="i-play" viewBox="0 0 24 24">
        <polygon points="6 3 20 12 6 21 6 3" />
      </symbol>
      <symbol id="i-pause" viewBox="0 0 24 24">
        <rect x="7" y="5" width="3.4" height="14" rx="1" />
        <rect x="13.6" y="5" width="3.4" height="14" rx="1" />
      </symbol>
      <symbol id="i-pin" viewBox="0 0 24 24">
        <path d="M12 3a4 4 0 0 1 4 4c0 3 2 4 2 6H6c0-2 2-3 2-6a4 4 0 0 1 4-4z" />
        <path d="M12 13v8" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" />
        <path d="m20.5 20.5-4.6-4.6" />
      </symbol>
      <symbol id="i-settings" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="2.7" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(0 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(45 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(90 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(135 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(180 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(225 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(270 12 12)" />
        <rect x="10.8" y="1.9" width="2.4" height="3.1" rx="0.7" transform="rotate(315 12 12)" />
      </symbol>
      <symbol id="i-shield" viewBox="0 0 24 24">
        <path d="M12 3.2 19 6v6c0 4.4-3 7.4-7 8.8-4-1.4-7-4.4-7-8.8V6z" />
      </symbol>
      <symbol id="i-sliders-horizontal" viewBox="0 0 24 24">
        <path d="M4 7h9M19 7h1M4 17h5M15 17h5" />
        <circle cx="15" cy="7" r="2.2" />
        <circle cx="11" cy="17" r="2.2" />
      </symbol>
      <symbol id="i-sparkles" viewBox="0 0 24 24">
        <path d="m12 4 1.7 4.6L18 10.3l-4.3 1.7L12 16.6l-1.7-4.6L6 10.3l4.3-1.7z" />
        <path d="m18.6 15.6.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
      </symbol>
      <symbol id="i-square" viewBox="0 0 24 24">
        <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 24 24">
        <path d="M18 6 6 18M6 6l12 12" />
      </symbol>
    </svg>
  );
}
