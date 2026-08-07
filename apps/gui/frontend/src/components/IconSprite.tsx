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
  | "vendor-claude"
  | "vendor-copilot"
  | "vendor-openai"
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
  | "git-fork"
  | "paperclip"
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
  | "refresh-cw"
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
      <symbol id="i-refresh-cw" viewBox="0 0 24 24">
        <path d="M20 11a8 8 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
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
      <symbol id="i-paperclip" viewBox="0 0 24 24">
        <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </symbol>
      <symbol id="i-git-merge" viewBox="0 0 24 24">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </symbol>
      <symbol id="i-git-fork" viewBox="0 0 24 24">
        <circle cx="7" cy="5" r="2.5" />
        <circle cx="17" cy="5" r="2.5" />
        <circle cx="12" cy="19" r="2.5" />
        <path d="M7 7.5v2A4.5 4.5 0 0 0 11.5 14H12" />
        <path d="M17 7.5v2a4.5 4.5 0 0 1-4.5 4.5H12v2.5" />
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
      {/* Brand paths are the CC0 Simple Icons marks, kept in the local sprite
          so the review controls never fetch an asset at runtime. */}
      <symbol id="i-vendor-claude" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          stroke="none"
          d="m4.714 15.956 4.718-2.648.079-.23-.08-.128h-.23l-.79-.048-2.695-.073-2.337-.097-2.265-.122-.57-.121-.535-.704.055-.353.48-.321.685.06 1.518.104 2.277.157 1.651.098 2.447.255h.389l.054-.158-.133-.097-.103-.098-2.356-1.596-2.55-1.688-1.336-.972-.722-.491L2 6.223l-.158-1.008.656-.722.88.06.224.061.893.686 1.906 1.476 2.49 1.833.364.304.146-.104.018-.072-.164-.274-1.354-2.446-1.445-2.49-.644-1.032-.17-.619a3 3 0 0 1-.103-.729L6.287.133 6.7 0l.995.134.42.364.619 1.415L9.735 4.14l1.555 3.03.455.898.243.832.09.255h.159V9.01l.127-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.558 2.903-.365 1.942h.213l.243-.242.983-1.306 1.652-2.064.728-.82.85-.904.547-.431h1.032l.759 1.129-.34 1.166-1.063 1.347-.88 1.142-1.263 1.7-.79 1.36.074.11.188-.02 2.853-.606 1.542-.28 1.84-.315.832.388.09.395-.327.807-1.967.486-2.307.462-3.436.813-.043.03.049.061 1.548.146.662.036h1.62l3.018.225.79.522.473.638-.08.485-1.213.62-1.64-.389-3.825-.91-1.31-.329h-.183v.11l1.093 1.068 2.003 1.81 2.508 2.33.127.578-.321.455-.34-.049-2.204-1.657-.85-.747-1.925-1.62h-.127v.17l.443.649 2.343 3.521.122 1.08-.17.353-.607.213-.668-.122-1.372-1.924-1.415-2.168-1.141-1.943-.14.08-.674 7.254-.316.37-.728.28-.607-.461-.322-.747.322-1.476.388-1.924.316-1.53.285-1.9.17-.632-.012-.042-.14.018-1.432 1.967-2.18 2.945-1.724 1.845-.413.164-.716-.37.066-.662.401-.589 2.386-3.036 1.439-1.882.929-1.086-.006-.158h-.055L4.138 18.56l-1.13.146-.485-.456.06-.746.231-.243 1.907-1.312Z"
        />
      </symbol>
      <symbol id="i-vendor-openai" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          stroke="none"
          d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
        />
      </symbol>
      <symbol id="i-vendor-copilot" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          stroke="none"
          d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02S.939 18.492.078 16.997A.6.6 0 0 1 0 16.741v-2.869a1 1 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10 10 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98s4.767.957 6.166 2.093c.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.8.8 0 0 1 .053.22v2.869a.6.6 0 0 1-.078.256m-11.75-5.992h-.344a4 4 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2 2 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179s6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4 4 0 0 1-.355-.508m2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1s-1-.451-1-1v-2c0-.549.451-1 1-1m-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1s-1-.451-1-1v-2c0-.549.451-1 1-1m3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021q0 .397.063.893m-1.626 0q.063-.496.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497"
        />
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
