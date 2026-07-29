import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { EditableTitle } from "~/components/EditableTitle";
import { Icon } from "~/components/Icon";
import { Panel } from "~/components/Panel";
import { ItemMarker, StatusDot } from "~/components/StatusDot";
import { relativeTime } from "~/lib/format";
import { statusSuffix } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { useWorkspace } from "~/stores/workspace";
import type { Project, ProjectItem } from "~/types";

const STATUS_TONE: Record<ProjectItem["status"], string> = {
  active: "font-semibold text-primary",
  pending: "text-az-muted",
  finished: "text-success",
  canceled: "text-az-faint",
};

/**
 * Home: every project with its items, plus Pinned and Recent.
 *
 * Two layers, one status enum. Clicking a project group opens its tab — the
 * list is a way in, not a second place to work.
 */
export function HomeTab(): JSX.Element {
  const { state, actions, itemsFor, tabStatus } = useWorkspace();
  const [query, setQuery] = createSignal("");

  const ordered = createMemo(() => [...state.projects].sort((a, b) => a.order - b.order));

  /**
   * Search spans both layers: typing an item title surfaces the project that
   * holds it, with the group's other items still shown for context.
   */
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return ordered();
    return ordered().filter(
      (project) =>
        project.name.toLowerCase().includes(needle) ||
        itemsFor(project.id).some((item) => item.title.toLowerCase().includes(needle)),
    );
  });

  const pinned = createMemo(() => ordered().filter((project) => project.pinned));

  const recent = createMemo(() =>
    [...state.projects].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
  );

  return (
    <div class="flex min-w-0 flex-1 gap-3">
      <Panel class="flex min-w-0 flex-1 flex-col">
        <div class="flex flex-col gap-[11px] px-4 pt-4 pb-3">
          <div class="flex items-baseline gap-2.5 px-0.5">
            <span class="font-semibold text-[15px] text-base-content">Projects</span>
            <span class="text-[11.5px] text-az-faint">
              and their items · click a project to open its tab
            </span>
          </div>

          {/*
            Half the row each. Home is on its way to becoming a Task Manager
            project — the thing that keeps the project and task lists organised —
            so the left half is reserved for it now rather than leaving one
            oversized search box to be cut in two later.
          */}
          <div class="flex items-stretch gap-2.5">
            <button
              type="button"
              disabled
              aria-label="Task Manager (not connected yet)"
              class="flex min-w-0 flex-1 cursor-default items-center gap-2.5 rounded-[11px] border border-white/11 border-dashed bg-az-inset px-3 py-2.5 text-left"
            >
              <Icon name="list-checks" class="shrink-0 text-[14px] text-az-muted" />
              <span class="min-w-0 flex-1 truncate text-[12.5px] text-az-muted">Task Manager</span>
              {/*
                Says what it is rather than looking like a button that ignores
                you. There is no task-manager project to open yet, and a control
                that silently does nothing is what we just removed from the
                project header.
              */}
              <span class="shrink-0 rounded-md border border-white/10 bg-base-300 px-[7px] py-0.5 font-mono text-[10.5px] text-az-faint">
                soon
              </span>
            </button>

            <div class="flex min-w-0 flex-1 items-center gap-2.5 rounded-[11px] border border-white/11 bg-az-inset px-3 py-2.5 focus-within:border-primary/40">
              <Icon name="search" class="shrink-0 text-[14px] text-az-muted" />
              <input
                type="search"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search projects and items…"
                aria-label="Search projects and items"
                class="min-w-0 flex-1 bg-transparent text-[12.5px] text-base-content placeholder:text-az-muted focus:outline-none"
              />
              <kbd class="shrink-0 rounded-md border border-white/10 bg-base-300 px-[7px] py-0.5 font-mono text-[10.5px] text-az-faint">
                ⌘K
              </kbd>
            </div>
          </div>
        </div>

        <div class="az-scroll flex min-h-0 flex-1 flex-col gap-2.5 px-3.5 pb-3.5">
          <For each={matches()}>{(project) => <ProjectGroup project={project} />}</For>
          <Show when={matches().length === 0}>
            <p class="px-2 py-6 text-center text-[12.5px] text-az-muted">
              Nothing matches “{query()}”.
            </p>
          </Show>
        </div>
      </Panel>

      <div class="flex w-[310px] flex-none flex-col gap-3">
        <button
          type="button"
          onClick={() => actions.openDraft()}
          class="flex items-center justify-center gap-2.5 rounded-panel bg-primary py-3.5 font-semibold text-[13.5px] text-primary-content shadow-[0_6px_20px_rgba(255,238,88,.12)] transition-colors hover:bg-[#fff176]"
        >
          <Icon name="plus" class="text-[17px]" />
          New Project
        </button>

        <Show when={pinned().length > 0}>
          <Panel class="flex-none">
            <div class="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
              <Icon name="pin" class="text-[13px] text-primary" />
              <span class="font-semibold text-[11.5px] text-az-muted uppercase tracking-[.06em]">
                Pinned
              </span>
            </div>
            <div class="flex flex-col gap-2 px-3 pb-3">
              <For each={pinned()}>
                {(project) => (
                  <button
                    type="button"
                    onClick={() => actions.openProject(project.id)}
                    class="flex items-center gap-2.5 rounded-[11px] border border-primary/22 bg-base-300 px-3 py-2.5 text-left transition-colors hover:border-primary/50"
                  >
                    <StatusDot status={tabStatus(project.id)} />
                    <span class="min-w-0 flex-1 truncate font-semibold text-[12.5px] text-base-content">
                      {project.name}
                    </span>
                    <span class="shrink-0 text-[11px] text-az-muted">
                      {itemsFor(project.id).filter((item) => item.status !== "finished").length}{" "}
                      open
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Panel>
        </Show>

        <Panel class="flex min-h-0 flex-1 flex-col">
          <div class="px-4 pt-3.5 pb-2.5 font-semibold text-[11.5px] text-az-muted uppercase tracking-[.06em]">
            Recent
          </div>
          <div class="az-scroll flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
            <For each={recent()}>
              {(project) => (
                <button
                  type="button"
                  onClick={() => actions.openProject(project.id)}
                  class="flex items-center gap-3 rounded-[11px] border border-az-hairline bg-base-300 px-3 py-2.5 text-left transition-colors hover:border-primary/40"
                >
                  <Icon name="folder-git-2" class="shrink-0 text-[15px] text-primary" />
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate font-semibold text-[12.5px] text-base-content">
                      {project.name}
                    </span>
                    <span class="truncate font-mono text-[11px] text-az-muted">
                      {project.dirs[0] ?? "no working directory"}
                    </span>
                  </div>
                  <span class="ml-auto shrink-0 text-[11px] text-az-faint">
                    {state.running[project.id]?.length
                      ? "running now"
                      : relativeTime(project.lastActivityAt)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ProjectGroup(props: { project: Project }): JSX.Element {
  const { actions, itemsFor } = useWorkspace();

  const [confirming, setConfirming] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);

  /**
   * The row is removed by the `project:deleted` event, not here, so a delete the
   * backend refused leaves the project on screen rather than vanishing it
   * optimistically and lying about what is stored.
   */
  const remove = async (): Promise<void> => {
    setIsDeleting(true);
    try {
      await actions.deleteProject(props.project.id);
    } catch (cause) {
      log.error(`could not delete ${props.project.id}: ${describeError(cause)}`);
      setConfirming(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const items = () => itemsFor(props.project.id);
  const openCount = () => items().filter((item) => item.status !== "finished").length;
  const activeCount = () => items().filter((item) => item.status === "active").length;
  const summary = () =>
    activeCount() ? `${openCount()} open · ${activeCount()} active` : `${openCount()} open`;

  return (
    <div class="overflow-hidden rounded-xl border border-az-hairline-soft bg-base-300">
      <div class="flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-white/4">
        {/*
          The name is its own control now, not part of the open-project button:
          a pencil nested inside a button would open the project on the way to
          editing it.
        */}
        <Icon name="folder-git-2" class="shrink-0 text-[15px] text-primary" />
        <EditableTitle
          value={props.project.name}
          onRename={(name) => actions.renameProject(props.project.id, name)}
          label={`Rename ${props.project.name}`}
          class="min-w-0 font-semibold text-[13px] text-base-content"
          inputClass="font-semibold text-[13px]"
        />
        <button
          type="button"
          onClick={() => actions.openProject(props.project.id)}
          aria-label={`Open ${props.project.name}`}
          class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span class={`shrink-0 text-[11.5px] ${STATUS_TONE[props.project.status]}`}>
            {statusSuffix(props.project.status)}
          </span>
          <span class="ml-auto shrink-0 text-[11.5px] text-az-muted">{summary()}</span>
        </button>

        <button
          type="button"
          onClick={() => void actions.setProjectPinned(props.project.id, !props.project.pinned)}
          aria-pressed={props.project.pinned}
          aria-label={props.project.pinned ? "Unpin project" : "Pin project"}
          class={`shrink-0 transition-colors ${props.project.pinned ? "text-primary" : "text-[oklch(48%_0.01_245)] hover:text-az-strong"}`}
        >
          <Icon name="pin" class="text-[14px]" />
        </button>

        {/*
          Two steps, in place, rather than a modal. Deleting a project takes its
          transcript and its task log with it and there is no undo, so a single
          click next to the pin toggle is too cheap — but a dialog for a row
          action is heavy, and the row is where the name is, which is the thing
          worth confirming.
        */}
        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${props.project.name}`}
              class="shrink-0 text-[oklch(48%_0.01_245)] transition-colors hover:text-error"
            >
              <Icon name="x" class="text-[14px]" />
            </button>
          }
        >
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="text-[11px] text-az-muted">Delete?</span>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={isDeleting()}
              class="rounded-md border border-error/40 bg-error/15 px-2 py-0.5 font-semibold text-[11px] text-error transition-colors hover:bg-error/25 disabled:opacity-50"
            >
              {isDeleting() ? "Deleting…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              class="rounded-md px-2 py-0.5 text-[11px] text-az-muted transition-colors hover:text-base-content"
            >
              Cancel
            </button>
          </div>
        </Show>

        <Icon name="chevron-right" class="shrink-0 text-[14px] text-[oklch(56%_0.01_245)]" />
      </div>

      <div class="flex flex-col border-az-hairline-soft border-t">
        <For each={items()}>
          {(item) => (
            <div class="flex cursor-default items-baseline gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-white/4">
              <Show
                when={item.status === "finished"}
                fallback={<ItemMarker status={item.status === "active" ? "active" : "pending"} />}
              >
                <Icon name="check" class="relative top-0.5 shrink-0 text-[13px] text-success" />
              </Show>
              <span
                class={`min-w-0 flex-1 text-[12.5px] ${
                  item.status === "active"
                    ? "text-az-strong"
                    : item.status === "finished"
                      ? "text-az-muted"
                      : "text-az-body"
                }`}
              >
                {item.title}
              </span>
              <span class={`shrink-0 text-[11.5px] ${STATUS_TONE[item.status]}`}>
                {statusSuffix(item.status)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
