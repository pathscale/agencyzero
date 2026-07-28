# AgencyZero GUI — design handover

Static export of the design source of truth. Everything here is generated from the
Omelette project "AgencyZero GUI"; edit there and re-export rather than hand-editing
these files.

Exported: 2026-07-29 · theme: 24x.ai dark tokens (contrast-tuned) · vocabulary: `agent-abstraction`

## Files

| File | What it is |
| --- | --- |
| `workspace.html` | The workspace mockup, standalone and offline (icons inlined, no CDN). Interactive: tabs, accordion sections, task-placement tweak. |
| `data-model.html` | The data-model spec: entities, enums, `agent-abstraction → UI` mapping, proposed Tauri surface, decision log. |
| `workspace-project.png` | Project tab — chat + accordion (Settings · Items · Running · Task log). |
| `workspace-home.png` | Home tab — projects with items, search, Pinned, Recent. |
| `workspace-new-project.png` | Untitled tab — the new-project prompt, centred. |
| `workspace-moderator-hold.png` | A moderator CRITICAL hold with Approve once / Deny, and the rate-limited header pill. |
| `workspace-settings.png` | Settings tab — agent status, defaults, moderator, notifications, environment. |
| `data-model.png` | Full-length render of the spec. |

## Screen → component map

Target: `apps/gui/frontend/` (SolidJS + `@pathscale/ui`, built into `apps/gui/dist/`).

| Region in the mockup | Component | Reads |
| --- | --- | --- |
| Tab strip (Home · Untitled · projects · Settings) | `ProjectTabs` | `Tab[]` (`kind`, `status` dot: running / blocked / error / quiet) |
| Home: projects + items, search, Pinned, Recent | `HomeProjectList` | `Project[]` + `ProjectItem[]` |
| Untitled: centred prompt | `NewProjectChat` | `ProjectDraft` — name and items come back from the first reply |
| Chat panel | `TranscriptPane` | `Message[]` — three authors: user · agent · moderator |
| Composer | `Composer` | `Tab.model`, `Tab.permission`, `Usage` |
| Right accordion, 4 sections | `ProjectAccordion` | `Project.dirs` · `ProjectItem[]` · `RunningTask[]` · `TaskLogEntry[]` |
| Settings tab | `SettingsTab` | `AgentStatus[]` + `GlobalSettings` |

`RunningTask` / `TaskLogEntry` are `Event::ToolCall` / `Event::ToolResult` from
`agent-abstraction`; `taskPlacement` in the mockup also shows a bottom-dock and an
inline-in-transcript variant of the same data.

## Rules the design encodes

- Permission is **per tab / per session**, set in the composer; `read_only` is the crate default.
- The moderator is a second agent reading both the transcript and the raw event stream.
  A hold carries a severity: **CHECK** (that step waits, the rest keeps running, amber dot)
  or **CRITICAL** (cancel the run and its process group, red dot).
- Text contrast floor is `oklch(62%)`; no pure white — the top tier is `oklch(82%)`.
- No network at runtime: all icons are inlined SVG symbols.

## Open items

Two parked TODOs, both in `data-model.html`: resuming after a CRITICAL halt (needs a double
confirmation flow), and transcript rendering for real markdown / diffs / long tool output.
