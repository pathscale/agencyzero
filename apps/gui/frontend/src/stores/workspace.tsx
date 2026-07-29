import {
  type Accessor,
  batch,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { AgencyZeroApi, AppEvents, Unlisten } from "~/api";
import { selectApi } from "~/api";
import { prefs, setPrefs } from "~/stores/prefs";
import type {
  AgentStatus,
  GlobalSettings,
  Message,
  Permission,
  Project,
  ProjectItem,
  ProjectStatus,
  RateLimit,
  RunningTask,
  Tab,
  TabStatus,
  TaskLogEntry,
} from "~/types";

const TASK_LOG_PAGE = 40;

type WorkspaceState = {
  projects: Project[];
  items: Record<string, ProjectItem[]>;
  messages: Record<string, Message[]>;
  running: Record<string, RunningTask[]>;
  taskLog: Record<string, TaskLogEntry[]>;
  logTotals: Record<string, number>;
  rateLimits: Record<string, RateLimit>;
  settings: GlobalSettings | null;
  agents: AgentStatus[];
  tabs: Tab[];
  activeKey: string;
  backend: "tauri" | "mock" | "loading";
  isLoaded: boolean;
};

const HOME_TAB: Tab = {
  key: "home",
  kind: "home",
  projectId: null,
  label: "Home",
  model: "sonnet",
  permission: "read_only",
  status: "quiet",
};

function createWorkspace() {
  const [state, setState] = createStore<WorkspaceState>({
    projects: [],
    items: {},
    messages: {},
    running: {},
    taskLog: {},
    logTotals: {},
    rateLimits: {},
    settings: null,
    agents: [],
    tabs: [HOME_TAB],
    activeKey: "home",
    backend: "loading",
    isLoaded: false,
  });

  const [api, setApi] = createSignal<AgencyZeroApi | null>(null);
  const unlisteners: Unlisten[] = [];

  const client = (): AgencyZeroApi => {
    const current = api();
    if (!current) throw new Error("workspace used before the backend was selected");
    return current;
  };

  // — derived ————————————————————————————————————————————————————

  const activeTab = createMemo(
    () => state.tabs.find((tab) => tab.key === state.activeKey) ?? HOME_TAB,
  );

  const activeProject = createMemo(() => {
    const projectId = activeTab().projectId;
    return projectId ? (state.projects.find((project) => project.id === projectId) ?? null) : null;
  });

  /**
   * The dot on a tab, derived rather than stored: an unresolved moderator hold
   * outranks a live tool call, which outranks quiet. Storing it would mean
   * four call sites remembering to keep it in step.
   */
  function tabStatus(projectId: string): TabStatus {
    const held = (state.messages[projectId] ?? []).some(
      (message) => message.moderation?.needsApproval === true,
    );
    if (held) {
      return state.messages[projectId]?.some(
        (message) =>
          message.moderation?.needsApproval && message.moderation.severity === "critical",
      )
        ? "error"
        : "blocked";
    }
    if (state.rateLimits[projectId]) return "blocked";
    if ((state.running[projectId] ?? []).length > 0) return "running";
    return "quiet";
  }

  function itemsFor(projectId: string): ProjectItem[] {
    return state.items[projectId] ?? [];
  }

  /** The Items badge counts what is left to do, so finished items drop out. */
  function openItemCount(projectId: string): number {
    return itemsFor(projectId).filter((item) => item.status !== "finished").length;
  }

  // — loading ————————————————————————————————————————————————————

  async function loadProject(projectId: string): Promise<void> {
    const backend = client();
    const [items, messages, running, log] = await Promise.all([
      backend.listItems(projectId),
      backend.listMessages(projectId),
      backend.listRunningTasks(projectId),
      backend.listTaskLog(projectId, TASK_LOG_PAGE),
    ]);
    batch(() => {
      setState("items", projectId, reconcile(items));
      setState("messages", projectId, reconcile(messages));
      setState("running", projectId, reconcile(running));
      setState("taskLog", projectId, reconcile(log.entries));
      setState("logTotals", projectId, log.total);
    });
  }

  async function init(): Promise<void> {
    const { api: backend, backend: kind } = await selectApi();
    setApi(() => backend);
    setState("backend", kind);

    const [projects, settings, agents, rateLimits] = await Promise.all([
      backend.listProjects(),
      backend.getSettings(),
      backend.listAgentStatus(false),
      backend.listRateLimits(),
    ]);

    batch(() => {
      setState("projects", reconcile(projects));
      setState("settings", settings);
      setState("agents", reconcile(agents));
      setState(
        "rateLimits",
        Object.fromEntries(rateLimits.map((limit) => [limit.projectId, limit])),
      );
      // Every project gets a tab, matching the mockup's strip. A project the
      // user closed would be reopened from the Home list.
      setState("tabs", [HOME_TAB, ...projects.map(projectTab)]);
      const restored = state.tabs.some((tab) => tab.key === prefs.lastTabKey);
      setState("activeKey", restored ? prefs.lastTabKey : "home");
    });

    await Promise.all(projects.map((project) => loadProject(project.id)));
    setState("isLoaded", true);
    subscribe(backend);
  }

  function projectTab(project: Project): Tab {
    return {
      key: project.id,
      kind: "project",
      projectId: project.id,
      label: project.name,
      model: prefs.lastModel,
      permission: prefs.lastPermission,
      status: "quiet",
    };
  }

  // — events ——————————————————————————————————————————————————————
  //
  // The agent runs the same mutations the user does, so the window is only
  // correct if it treats these as the source of truth rather than trusting its
  // own optimistic writes.

  async function subscribe(backend: AgencyZeroApi): Promise<void> {
    const bind = async <E extends keyof AppEvents>(
      event: E,
      handler: (payload: AppEvents[E]) => void,
    ) => {
      unlisteners.push(await backend.on(event, handler));
    };

    // No tab is opened here. The agent creates projects too, and a new tab
    // appearing in the strip mid-sentence would be the agent taking the window
    // from you. It lands in Home; opening it is a click.
    await bind("project:created", (project) => {
      upsertProject(project);
      void loadProject(project.id);
    });

    await bind("project:updated", upsertProject);

    await bind("project:deleted", ({ id }) => closeProjectTab(id));

    await bind("item:created", (item) => {
      setState("items", item.projectId, (list = []) => [...list, item]);
    });

    await bind("item:updated", (item) => {
      setState("items", item.projectId, (list = []) =>
        list.map((existing) => (existing.id === item.id ? item : existing)),
      );
    });

    await bind("item:deleted", ({ id, projectId }) => {
      setState("items", projectId, (list = []) => list.filter((item) => item.id !== id));
    });

    const appendMessage = (message: Message) => {
      setState("messages", message.projectId, (list = []) => {
        const index = list.findIndex((existing) => existing.id === message.id);
        if (index < 0) return [...list, message];
        const next = [...list];
        next[index] = message;
        return next;
      });
    };
    await bind("message:appended", appendMessage);
    await bind("moderation:blocked", appendMessage);

    const upsertTask = (task: RunningTask) => {
      setState("running", task.projectId, (list = []) => {
        const index = list.findIndex((existing) => existing.toolCallId === task.toolCallId);
        if (index < 0) return [...list, task];
        const next = [...list];
        next[index] = task;
        return next;
      });
    };
    await bind("task:started", upsertTask);
    await bind("task:progress", upsertTask);

    await bind("task:finished", (entry) => {
      batch(() => {
        setState("running", entry.projectId, (list = []) =>
          list.filter((task) => task.label !== entry.label),
        );
        setState("taskLog", entry.projectId, (list = []) => [entry, ...list]);
        setState("logTotals", entry.projectId, (total = 0) => total + 1);
      });
    });

    await bind("run:rate_limit", (limit) => {
      setState("rateLimits", limit.projectId, limit);
    });

    await bind("run:stopped", ({ projectId }) => {
      setState("running", projectId, []);
    });
  }

  function upsertProject(project: Project): void {
    setState(
      produce((draft) => {
        const index = draft.projects.findIndex((existing) => existing.id === project.id);
        if (index < 0) draft.projects.push(project);
        else draft.projects[index] = project;

        const tab = draft.tabs.find((candidate) => candidate.key === project.id);
        if (tab) tab.label = project.name;
      }),
    );
  }

  onCleanup(() => {
    for (const unlisten of unlisteners) unlisten();
  });

  // — tabs ————————————————————————————————————————————————————————

  function focus(key: string): void {
    if (!state.tabs.some((tab) => tab.key === key)) return;
    batch(() => {
      setState("activeKey", key);
      setPrefs("lastTabKey", key);
    });
  }

  /**
   * Step through the strip in its current visual order, wrapping at both ends.
   *
   * Index-based on `state.tabs`, which *is* the strip order — so a tab dragged
   * to a new position is immediately in that position for cycling too, with
   * nothing to keep in step.
   */
  function cycleTab(delta: number): void {
    const index = state.tabs.findIndex((tab) => tab.key === state.activeKey);
    if (index < 0 || state.tabs.length < 2) return;
    const count = state.tabs.length;
    focus(state.tabs[(index + delta + count) % count].key);
  }

  /** Move a tab within the strip. Home is index 0 and stays there. */
  function moveTab(key: string, toIndex: number): void {
    const from = state.tabs.findIndex((tab) => tab.key === key);
    if (from <= 0) return;
    const to = Math.min(Math.max(toIndex, 1), state.tabs.length - 1);
    if (from === to) return;
    setState("tabs", (tabs) => {
      const next = [...tabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  /**
   * Persist the strip order, once, when a drag ends.
   *
   * Only the project run is persistable — `Project.order` is a real field, and
   * `listProjects` returns them sorted by it, so the order survives a restart.
   * Draft and Settings tabs are window state and keep their place only for as
   * long as they are open.
   */
  async function commitTabOrder(): Promise<void> {
    const ids = state.tabs
      .filter((tab) => tab.kind === "project" && tab.projectId)
      .map((tab) => tab.projectId as string);
    if (ids.length > 1) await client().reorderProjects(ids);
  }

  function openProject(projectId: string): void {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    if (!state.tabs.some((tab) => tab.key === projectId)) {
      setState("tabs", (tabs) => [...tabs, projectTab(project)]);
    }
    focus(projectId);
  }

  /** The gear opens Settings as a real tab you can leave open — never a modal. */
  function openSettings(): void {
    if (!state.tabs.some((tab) => tab.kind === "settings")) {
      setState("tabs", (tabs) => [
        ...tabs,
        { ...HOME_TAB, key: "settings", kind: "settings", label: "Settings" },
      ]);
    }
    focus("settings");
  }

  /** One draft at a time: a second "+" focuses the Untitled tab already open. */
  function openDraft(): void {
    const existing = state.tabs.find((tab) => tab.kind === "draft");
    if (existing) {
      focus(existing.key);
      return;
    }
    const key = `draft-${Date.now()}`;
    setState("tabs", (tabs) => [
      ...tabs,
      {
        key,
        kind: "draft",
        projectId: null,
        label: "Untitled",
        model: prefs.lastModel,
        permission: prefs.lastPermission,
        status: "quiet",
      },
    ]);
    focus(key);
  }

  function closeTab(key: string): void {
    if (key === "home") return; // Home is not closable.
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    batch(() => {
      setState("tabs", (tabs) => tabs.filter((tab) => tab.key !== key));
      if (state.activeKey === key) {
        // Fall back to the tab on the left, which is where the eye already is.
        focus(state.tabs[Math.max(0, index - 1)]?.key ?? "home");
      }
    });
  }

  function closeProjectTab(projectId: string): void {
    batch(() => {
      setState("projects", (projects) => projects.filter((project) => project.id !== projectId));
      closeTab(projectId);
    });
  }

  /** Model and posture are per tab and sticky; UiPrefs only seeds the next new tab. */
  function setTabModel(key: string, model: string, permission: Permission): void {
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    batch(() => {
      setState("tabs", index, { model, permission });
      setPrefs({ lastModel: model, lastPermission: permission });
    });
    void client().setTabModel(key, model, permission);
  }

  // — mutations ————————————————————————————————————————————————————
  //
  // Each of these fires a command and lets the resulting event update the
  // store, so a change made by the agent and one made here land the same way.

  async function createProject(firstMessage: string, tabKey: string): Promise<void> {
    const tab = state.tabs.find((candidate) => candidate.key === tabKey);
    const created = await client().createProject({
      firstMessage,
      model: tab?.model,
      permission: tab?.permission,
    });
    batch(() => {
      // The draft becomes the project tab: same position in the strip, so the
      // tab you were typing in is the tab that keeps the conversation. Any tab
      // already holding this project is dropped rather than duplicated.
      setState("tabs", (tabs) =>
        tabs
          .filter((candidate) => candidate.key !== created.project.id)
          .map((candidate) =>
            candidate.key === tabKey
              ? {
                  ...candidate,
                  key: created.project.id,
                  kind: "project" as const,
                  projectId: created.project.id,
                  label: created.project.name,
                }
              : candidate,
          ),
      );
      setState("items", created.project.id, created.items);
      focus(created.project.id);
    });
  }

  const send = async (projectId: string, body: string): Promise<void> => {
    const tab = state.tabs.find((candidate) => candidate.projectId === projectId);
    await client().sendMessage({
      projectId,
      body,
      model: tab?.model,
      permission: tab?.permission,
    });
  };

  const actions = {
    focus,
    cycleTab,
    moveTab,
    commitTabOrder,
    openProject,
    openSettings,
    openDraft,
    closeTab,
    setTabModel,
    createProject,
    send,
    deleteProject: (id: string) => client().deleteProject(id),
    setProjectStatus: (id: string, status: ProjectStatus) => client().setProjectStatus(id, status),
    setProjectPinned: (id: string, pinned: boolean) => client().setProjectPinned(id, pinned),
    setProjectModerator: (id: string, enabled: boolean) =>
      client().setProjectModerator(id, enabled),
    addDir: (projectId: string, path: string) => client().addDir(projectId, path),
    removeDir: (projectId: string, path: string) => client().removeDir(projectId, path),
    createItem: (projectId: string, title: string) => client().createItem(projectId, title),
    setItemStatus: (id: string, status: ProjectStatus) => client().setItemStatus(id, status),
    deleteItem: (id: string) => client().deleteItem(id),
    resolveModeration: (messageId: string, approve: boolean) =>
      client().resolveModeration(messageId, approve),
    cancelTask: (toolCallId: string) => client().cancelTask(toolCallId),
    cancelRun: (projectId: string) => client().cancelRun(projectId),
    async clearTaskLog(projectId: string) {
      await client().clearTaskLog(projectId);
      batch(() => {
        setState("taskLog", projectId, []);
        setState("logTotals", projectId, 0);
      });
    },
    async saveSettings(patch: Parameters<AgencyZeroApi["setSettings"]>[0]) {
      const next = await client().setSettings(patch);
      setState("settings", next);
    },
    async recheckAgents() {
      setState("agents", reconcile(await client().listAgentStatus(true)));
    },
  };

  return { state, actions, activeTab, activeProject, tabStatus, itemsFor, openItemCount, init };
}

export type Workspace = ReturnType<typeof createWorkspace>;

const WorkspaceContext = createContext<Workspace>();

export function WorkspaceProvider(
  props: ParentProps,
): ReturnType<typeof WorkspaceContext.Provider> {
  const workspace = createWorkspace();
  void workspace.init();
  return <WorkspaceContext.Provider value={workspace}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return workspace;
}

/** A ticking clock for the elapsed counters, shared by every running-task row. */
export function useNow(intervalMs = 1000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}
