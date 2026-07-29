import { Toggle } from "@pathscale/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { SectionPanel } from "~/components/Panel";
import { ItemMarker } from "~/components/StatusDot";
import { elapsed, taskMeta } from "~/lib/format";
import { statusSuffix } from "~/lib/labels";
import { prefs, togglePanelSection } from "~/stores/prefs";
import { useNow, useWorkspace } from "~/stores/workspace";
import type { Project, ProjectItem } from "~/types";

/**
 * The project's right-hand accordion: Settings · Items · Running · Task log.
 *
 * This replaced the old left sidebar. Open state lives in `UiPrefs`, per
 * install rather than per project, so the panel you left open stays open when
 * you switch tabs.
 */
export function ProjectPanel(props: { project: Project }): JSX.Element {
  const { state, itemsFor, openItemCount } = useWorkspace();

  const running = () => state.running[props.project.id] ?? [];
  const log = () => state.taskLog[props.project.id] ?? [];

  return (
    <div class="az-scroll flex w-[322px] flex-none flex-col gap-2.5">
      <SettingsSection project={props.project} />

      <SectionPanel
        icon="list-checks"
        title="Items"
        count={openItemCount(props.project.id)}
        isOpen={prefs.panelSections.items}
        onToggle={() => togglePanelSection("items")}
        class="flex-none"
      >
        <ItemList projectId={props.project.id} items={itemsFor(props.project.id)} />
      </SectionPanel>

      <SectionPanel
        title="Running"
        count={running().length}
        countTone="primary"
        trailing={
          <span
            class={`size-2 rounded-full ${running().length ? "az-halo-primary bg-primary" : "bg-white/22"}`}
          />
        }
        isOpen={prefs.panelSections.running}
        onToggle={() => togglePanelSection("running")}
        class="flex-none"
      >
        <RunningList projectId={props.project.id} />
      </SectionPanel>

      <SectionPanel
        icon="history"
        title="Task log"
        count={state.logTotals[props.project.id] ?? log().length}
        lead={<ClearLogButton projectId={props.project.id} />}
        isOpen={prefs.panelSections.log}
        onToggle={() => togglePanelSection("log")}
        class="flex min-h-[160px] flex-col"
      >
        <TaskLogList projectId={props.project.id} />
      </SectionPanel>
    </div>
  );
}

/**
 * Working directories and the per-session moderator toggle — and nothing else.
 *
 * Model and permission are deliberately absent: they are per tab and live only
 * in the composer, which is the note this section ends on.
 */
function SettingsSection(props: { project: Project }): JSX.Element {
  const { state, actions } = useWorkspace();
  const [adding, setAdding] = createSignal(false);
  const [path, setPath] = createSignal("");

  const moderatorDefault = () => state.settings?.moderator.enabled ?? true;

  async function addDir(): Promise<void> {
    const value = path().trim();
    if (!value) return;
    await actions.addDir(props.project.id, value);
    setPath("");
    setAdding(false);
  }

  return (
    <SectionPanel
      icon="sliders-horizontal"
      title="Settings"
      note={`· ${props.project.dirs.length} ${props.project.dirs.length === 1 ? "dir" : "dirs"}`}
      isOpen={prefs.panelSections.settings}
      onToggle={() => togglePanelSection("settings")}
      class="flex-none"
    >
      <div class="flex flex-col gap-2.5 px-3 pt-3 pb-3.5">
        <div class="text-[11.5px] text-az-muted">Working directories</div>

        <For each={props.project.dirs}>
          {(dir) => (
            <div class="flex min-w-0 items-center gap-2 rounded-[9px] border border-az-hairline-soft bg-base-300 px-2.5 py-[7px]">
              <Icon name="folder" class="shrink-0 text-[13px] text-az-muted" />
              <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-az-body">
                {dir}
              </span>
              <button
                type="button"
                onClick={() => void actions.removeDir(props.project.id, dir)}
                aria-label={`Remove ${dir}`}
                class="shrink-0 text-az-faint transition-colors hover:text-error"
              >
                <Icon name="x" class="text-[13px]" />
              </button>
            </div>
          )}
        </For>

        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              onClick={() => setAdding(true)}
              class="flex items-center gap-[7px] rounded-[9px] border border-white/16 border-dashed px-2.5 py-[7px] text-[11.5px] text-az-muted transition-colors hover:border-primary hover:text-primary"
            >
              <Icon name="folder-plus" class="text-[13px]" />
              Add dir
            </button>
          }
        >
          {/*
            A typed path rather than a native folder picker: opening one needs
            the Tauri dialog plugin, which is not wired up on the Rust side yet.
          */}
          <input
            autofocus
            value={path()}
            placeholder="~/src/…"
            aria-label="Working directory path"
            onInput={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addDir();
              if (event.key === "Escape") setAdding(false);
            }}
            onBlur={() => void addDir()}
            class="rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-[7px] font-mono text-[11.5px] text-az-body focus:outline-none"
          />
        </Show>

        <div class="my-0.5 h-px bg-az-hairline-soft" />

        <div class="flex items-center gap-2.5">
          <Icon name="shield" class="shrink-0 text-[14px] text-warning" />
          <span class="min-w-0 flex-1 text-[12px] text-az-body">
            Moderator
            <span class="mt-px block text-[11px] text-az-muted">
              this session · global default is {moderatorDefault() ? "on" : "off"}
            </span>
          </span>
          <Toggle
            aria-label="Moderator for this session"
            checked={props.project.moderatorEnabled}
            color="accent"
            size="sm"
            onChange={(event) =>
              void actions.setProjectModerator(props.project.id, event.currentTarget.checked)
            }
          />
        </div>

        <div class="flex gap-[7px] pt-0.5 text-[11px] text-az-faint leading-[1.5]">
          <Icon name="info" class="relative top-0.5 shrink-0 text-[12px]" />
          Model and permission are per tab — set them in the composer. Everything else lives in
          global settings.
        </div>
      </div>
    </SectionPanel>
  );
}

function ItemList(props: { projectId: string; items: ProjectItem[] }): JSX.Element {
  const { actions } = useWorkspace();
  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal("");

  async function create(): Promise<void> {
    const value = title().trim();
    if (value) await actions.createItem(props.projectId, value);
    setTitle("");
    setAdding(false);
  }

  /** Clicking an item cycles pending → active → finished → pending. */
  function advance(item: ProjectItem): void {
    const next =
      item.status === "pending" ? "active" : item.status === "active" ? "finished" : "pending";
    void actions.setItemStatus(item.id, next);
  }

  return (
    <div class="az-scroll flex max-h-[300px] flex-col gap-0.5 px-2 pt-1.5 pb-2.5">
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            onClick={() => advance(item)}
            title="Change status"
            class={`flex items-baseline gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors ${
              item.status === "active"
                ? "bg-base-300 shadow-[inset_2px_0_0_#ffee58]"
                : "hover:bg-white/5"
            }`}
          >
            <Show
              when={item.status === "finished"}
              fallback={<ItemMarker status={item.status === "active" ? "active" : "pending"} />}
            >
              <Icon name="check" class="relative top-0.5 shrink-0 text-[12px] text-success" />
            </Show>
            <span
              class={`min-w-0 flex-1 text-[12.5px] ${
                item.status === "active"
                  ? "text-base-content"
                  : item.status === "finished"
                    ? "text-az-muted"
                    : "text-az-body"
              }`}
            >
              {item.title}
            </span>
            <span
              class={`shrink-0 text-[11px] ${
                item.status === "active"
                  ? "font-semibold text-primary"
                  : item.status === "finished"
                    ? "text-success"
                    : "text-az-muted"
              }`}
            >
              {statusSuffix(item.status)}
            </span>
          </button>
        )}
      </For>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            onClick={() => setAdding(true)}
            class="mt-1 flex items-center gap-2 rounded-[9px] border border-white/16 border-dashed px-2.5 py-2 text-[12px] text-az-muted transition-colors hover:border-primary hover:text-primary"
          >
            <Icon name="plus" class="text-[13px]" />
            New item
          </button>
        }
      >
        <input
          autofocus
          value={title()}
          placeholder="What needs doing?"
          aria-label="New item"
          onInput={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
            if (event.key === "Escape") setAdding(false);
          }}
          onBlur={() => void create()}
          class="mt-1 rounded-[9px] border border-primary/40 bg-base-300 px-2.5 py-2 text-[12px] text-az-body focus:outline-none"
        />
      </Show>
    </div>
  );
}

function RunningList(props: { projectId: string }): JSX.Element {
  const { state, actions } = useWorkspace();
  const now = useNow();
  const tasks = () => state.running[props.projectId] ?? [];

  return (
    <div class="az-scroll flex max-h-[230px] flex-col gap-2 px-3 pt-3 pb-3">
      <For each={tasks()}>
        {(task) => (
          <div class="rounded-[11px] border border-primary/22 bg-base-300 px-3 py-2.5">
            <div class="truncate font-mono text-[12px] text-az-strong">{task.label}</div>
            <div class="mt-2 flex items-center gap-2 text-[11px]">
              <span class="font-mono text-az-muted">{task.name}</span>
              <span class="text-primary">{elapsed(task.startedAt, now())}</span>
              <div class="flex-1" />
              <button
                type="button"
                disabled={!task.isCancelable || !task.toolCallId}
                onClick={() => task.toolCallId && void actions.cancelTask(task.toolCallId)}
                class="rounded-md border border-white/16 px-2 py-0.5 text-az-body transition-colors hover:border-error hover:text-error disabled:opacity-40"
              >
                Stop
              </button>
            </div>
          </div>
        )}
      </For>

      <Show when={tasks().length === 0}>
        <p class="rounded-[11px] border border-white/12 border-dashed p-3 text-center text-[11.5px] text-az-muted">
          Nothing running
        </p>
      </Show>
    </div>
  );
}

function TaskLogList(props: { projectId: string }): JSX.Element {
  const { state } = useWorkspace();
  const entries = () => state.taskLog[props.projectId] ?? [];

  return (
    <div class="az-scroll flex min-h-0 flex-1 flex-col gap-[7px] px-3 pt-2.5 pb-3">
      <For each={entries()}>
        {(entry) => (
          /*
           * Three states, not two. `ok` is `boolean | null`, and null means the
           * agent did not report an outcome — which is not failure. Rendering
           * it with the error mark would tell you a tool failed when nothing
           * said so.
           */
          <div class="flex items-baseline gap-2 text-[11.5px]">
            <Icon
              name={entry.ok === true ? "check" : entry.ok === false ? "x" : "info"}
              label={entry.ok === null ? "Outcome not reported" : undefined}
              class={`shrink-0 text-[12px] ${
                entry.ok === true
                  ? "text-success"
                  : entry.ok === false
                    ? "text-error"
                    : "text-az-muted"
              }`}
            />
            <span class="min-w-0 flex-1 truncate text-az-body">{entry.label}</span>
            <span class={`shrink-0 ${entry.ok === false ? "text-error" : "text-az-muted"}`}>
              {taskMeta(entry)}
            </span>
          </div>
        )}
      </For>

      <Show when={entries().length === 0}>
        <p class="py-3 text-center text-[11.5px] text-az-muted">Nothing has run yet</p>
      </Show>
    </div>
  );
}

function ClearLogButton(props: { projectId: string }): JSX.Element {
  const { actions } = useWorkspace();
  return (
    <button
      type="button"
      onClick={() => void actions.clearTaskLog(props.projectId)}
      class="shrink-0 text-[11px] text-az-faint transition-colors hover:text-base-content"
    >
      Clear
    </button>
  );
}
