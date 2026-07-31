import type {
  AgentIoEntry,
  AgentModels,
  AgentStatus,
  CreatedProject,
  DataLocationView,
  GlobalSettings,
  Message,
  Project,
  ProjectItem,
  ProjectStatus,
  QuotaReport,
  RunningTask,
  TaskLogEntry,
} from "~/types";
import type { AgencyZeroApi, AppEvents, DeepPartial, Unlisten } from "./client";
import * as fixtures from "./fixtures";

/**
 * An in-memory stand-in for the Rust side.
 *
 * The Tauri commands in `design/data-model.html` do not exist yet — `az-gui`
 * still only exposes `greet` — so this serves the mockup's own data through the
 * exact same interface. It exists to make the frontend reviewable and the
 * cutover boring: when the commands land, `./index.ts` picks the real client
 * and nothing above the api/ directory changes.
 *
 * It is a stand-in, not a simulation. Where behaviour would need real agent
 * output to be meaningful — parsing a project name out of a first reply,
 * streaming a run — it does the smallest honest thing and says so.
 */

const LATENCY_MS = 90;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Commands resolve on a short delay so loading states are actually exercised. */
function settle<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(clone(value)), LATENCY_MS));
}

function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  const out = { ...target };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key as keyof DeepPartial<T>];
    if (value === undefined) continue;
    const existing = out[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      typeof value === "object"
    ) {
      out[key] = deepMerge(existing, value as DeepPartial<typeof existing>);
    } else {
      out[key] = value as T[keyof T];
    }
  }
  return out;
}

let idCounter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`;

export function createMockApi(): AgencyZeroApi {
  const projects = clone(fixtures.PROJECTS);
  const items = clone(fixtures.ITEMS);
  const messages = clone(fixtures.MESSAGES);
  const running = clone(fixtures.RUNNING);
  const taskLog = clone(fixtures.TASK_LOG);
  const logTotals = { ...fixtures.LOG_TOTALS };
  // The Home task manager's conversation handle; reset clears it.
  let taskManagerSession: string | null = "d991b0f0-fixture-4c9217d0";
  const agentStatus = clone(fixtures.AGENT_STATUS);
  const models = clone(fixtures.MODEL_CATALOGUE);
  let settings = clone(fixtures.SETTINGS);
  const pullRequests = clone(fixtures.PULL_REQUESTS);

  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  function emit<E extends keyof AppEvents>(event: E, payload: AppEvents[E]): void {
    for (const handler of listeners.get(event) ?? []) handler(clone(payload));
  }

  const findProject = (id: string) => {
    const project = projects.find((candidate) => candidate.id === id);
    if (!project) throw new Error(`unknown project: ${id}`);
    return project;
  };

  const findItem = (id: string) => {
    const found = items.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`unknown item: ${id}`);
    return found;
  };

  /** Every project mutation goes out as `project:updated`, exactly as Rust will. */
  function touch(project: Project): Promise<Project> {
    project.lastActivityAt = new Date().toISOString();
    emit("project:updated", project);
    return settle(project);
  }

  return {
    listProjects: () => settle([...projects].sort((a, b) => a.order - b.order)),

    async createProject(input): Promise<CreatedProject> {
      // The real command gets the name and the opening items back from the
      // agent's first reply. With no agent, the first line of what was typed
      // is the closest honest stand-in.
      const name = input.firstMessage.trim().split("\n")[0].slice(0, 48) || "Untitled";
      const project: Project = {
        id: nextId("project"),
        name,
        status: "active",
        order: projects.length,
        dirs: [],
        pinned: false,
        moderatorEnabled: settings.moderator.enabled,
        forkedFrom: null,
        // The mock never runs an agent, so there is no session to report.
        sessionId: null,
        lastActivityAt: new Date().toISOString(),
      };
      projects.push(project);

      const first: Message = {
        id: nextId("message"),
        projectId: project.id,
        itemId: null,
        author: "user",
        agent: settings.defaultAgent,
        moderation: null,
        model: input.model ?? settings.models[settings.defaultAgent].default,
        permission: input.permission ?? settings.defaultPermission,
        usage: null,
        stop: "completed",
        exitCode: null,
        body: input.firstMessage,
        createdAt: new Date().toISOString(),
      };
      messages.push(first);
      logTotals[project.id] = 0;

      emit("project:created", project);
      emit("message:appended", first);
      return settle({ project, items: [] });
    },

    async renameProject(id, name) {
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) throw new Error(`unknown project: ${id}`);
      project.name = name.trim();
      emit("project:updated", project);
      return settle(project);
    },

    async deleteProject(id) {
      const index = projects.findIndex((project) => project.id === id);
      if (index >= 0) projects.splice(index, 1);

      // Every collection this project owns goes with it. Leaving messages or a
      // task log behind would let them resurface under a reused id.
      const drop = <T extends { projectId: string }>(list: T[]) => {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].projectId === id) list.splice(i, 1);
        }
      };
      drop(items);
      drop(messages);
      drop(running);
      drop(taskLog);
      delete logTotals[id];

      emit("project:deleted", { id });
      return settle(undefined);
    },

    setProjectStatus: (id, status) => {
      const project = findProject(id);
      project.status = status;
      return touch(project);
    },

    async reorderProjects(ids) {
      ids.forEach((id, order) => {
        const project = projects.find((candidate) => candidate.id === id);
        if (project) project.order = order;
      });
      const ordered = [...projects].sort((a, b) => a.order - b.order);
      for (const project of ordered) emit("project:updated", project);
      return settle(ordered);
    },

    setProjectPinned: (id, pinned) => {
      const project = findProject(id);
      project.pinned = pinned;
      return touch(project);
    },

    setProjectModerator: (id, enabled) => {
      const project = findProject(id);
      project.moderatorEnabled = enabled;
      return touch(project);
    },

    async forkProject(projectId, messageId) {
      const source = findProject(projectId);
      // A fork branches into a new session id, so it is a new project tab that
      // shares history up to that message — not a second view of this one.
      const cutoff = messages.findIndex((message) => message.id === messageId);
      const fork: Project = {
        ...clone(source),
        id: nextId("project"),
        name: `${source.name} (fork)`,
        order: projects.length,
        forkedFrom: { projectId, messageId },
        lastActivityAt: new Date().toISOString(),
      };
      projects.push(fork);

      if (cutoff >= 0) {
        for (const message of messages.slice(0, cutoff + 1)) {
          if (message.projectId !== projectId) continue;
          messages.push({ ...clone(message), id: nextId("message"), projectId: fork.id });
        }
      }
      logTotals[fork.id] = 0;
      emit("project:created", fork);
      return settle(fork);
    },

    addDir: (projectId, path) => {
      const project = findProject(projectId);
      if (!project.dirs.includes(path)) project.dirs.push(path);
      return touch(project);
    },

    removeDir: (projectId, path) => {
      const project = findProject(projectId);
      project.dirs = project.dirs.filter((dir) => dir !== path);
      return touch(project);
    },

    listPullRequests: (projectId) =>
      settle(pullRequests.filter((pr) => pr.projectId === projectId)),

    async dismissPullRequest(id) {
      const pr = pullRequests.find((candidate) => candidate.id === id);
      if (!pr) return settle(undefined);
      pr.dismissed = true;
      emit("pr:updated", pr);
      return settle(undefined);
    },

    // The mock has no gh to ask; a refresh re-announces what it has.
    async refreshPullRequest(id) {
      const pr = pullRequests.find((candidate) => candidate.id === id);
      if (pr) emit("pr:updated", pr);
      return settle(undefined);
    },

    listItems: (projectId) =>
      settle(
        items.filter((item) => item.projectId === projectId).sort((a, b) => a.order - b.order),
      ),

    async createItem(projectId, title) {
      const siblings = items.filter((item) => item.projectId === projectId);
      const item: ProjectItem = {
        id: nextId("item"),
        projectId,
        title,
        status: "pending",
        order: siblings.length,
      };
      items.push(item);
      emit("item:created", item);
      return settle(item);
    },

    async deleteItem(id) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return settle(undefined);
      const [removed] = items.splice(index, 1);
      emit("item:deleted", { id, projectId: removed.projectId });
      return settle(undefined);
    },

    async setItemStatus(id, status: ProjectStatus) {
      const item = findItem(id);
      item.status = status;
      emit("item:updated", item);
      return settle(item);
    },

    async updateItem(id, title) {
      const item = findItem(id);
      item.title = title;
      emit("item:updated", item);
      return settle(item);
    },

    async reorderItems(projectId, ids) {
      ids.forEach((id, order) => {
        const item = items.find((candidate) => candidate.id === id);
        if (item) item.order = order;
      });
      const ordered = items
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => a.order - b.order);
      for (const item of ordered) emit("item:updated", item);
      return settle(ordered);
    },

    listMessages: (projectId) =>
      settle(messages.filter((message) => message.projectId === projectId)),

    async sendMessage(input) {
      // The task manager is reserved with no project row, exactly like Rust:
      // its messages hang off the fixed id and nothing else is touched.
      const project = input.projectId === "home-task-manager" ? null : findProject(input.projectId);
      const message: Message = {
        id: nextId("message"),
        projectId: input.projectId,
        itemId: input.itemId ?? null,
        author: "user",
        agent: settings.defaultAgent,
        moderation: null,
        model: input.model ?? settings.models[settings.defaultAgent].default,
        permission: input.permission ?? settings.defaultPermission,
        usage: null,
        stop: "completed",
        exitCode: null,
        body: input.body,
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      emit("message:appended", message);
      if (project) {
        project.lastActivityAt = message.createdAt;
        emit("project:updated", project);
      }
      // No reply is faked: an invented agent answer would be indistinguishable
      // from a real one in review, and that is exactly the wrong thing to ship.
      return settle(message);
    },

    async resolveModeration(messageId, approve) {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message?.moderation) throw new Error(`no moderation on message: ${messageId}`);
      message.moderation = {
        ...message.moderation,
        verdict: approve ? "flagged" : "noted",
        needsApproval: false,
      };
      emit("message:appended", message);
      return settle(message);
    },

    getSettings: () => settle(settings),

    async setSettings(patch): Promise<GlobalSettings> {
      settings = deepMerge(settings, patch);
      return settle(settings);
    },

    listAgentStatus(recheck): Promise<AgentStatus[]> {
      if (recheck) {
        const checkedAt = new Date().toISOString();
        for (const status of agentStatus) status.checkedAt = checkedAt;
      }
      return settle(agentStatus);
    },

    /*
     * `discover` is accepted and ignored: the mock has no CLI to ask, and every
     * entry stays `discovered: false` for that reason. Reporting discovery it
     * did not do would make the Settings provenance line lie.
     */
    listModels(_discover): Promise<AgentModels[]> {
      return settle(models);
    },

    /*
     * There is no database outside Tauri, so this reports the shape without
     * claiming a real path, and `isEditable: false` keeps the browser from
     * offering to move something that does not exist.
     */
    /* Plausible shapes rather than a real walk: there is no store outside Tauri,
     * and the point of the row is the *ordering* — that the log dwarfs the
     * transcript is the thing worth seeing. */
    listTableSizes: () =>
      settle([
        { name: "task_log", bytes: 2_411_724 },
        { name: "agent_io_row", bytes: 968_320 },
        { name: "message", bytes: 430_080 },
        { name: "kv", bytes: 397_312 },
        { name: "usage_ledger", bytes: 131_072 },
        { name: "project_item", bytes: 126_976 },
        { name: "project", bytes: 65_536 },
      ]),

    getDataLocation(): Promise<DataLocationView> {
      return settle({
        path: "(in-memory fixtures)",
        source: "default",
        isEditable: false,
        pending: null,
      });
    },
    setDataLocation: () => settle(undefined),
    /*
     * Cancelled, always. A browser has no native picker to open, and answering
     * with a plausible path would have the fixtures pretending to a filesystem
     * they do not have.
     */
    chooseDataDirectory: () => settle(null),
    // A fixed fixture path: the preview has no OS picker to open.
    chooseAttachments: () => settle(["/tmp/mock-attachment.txt"]),

    /* No filesystem outside Tauri, so this describes the shape and claims nothing. */
    getWorkspaceRoot: () => settle({ path: "(no filesystem)", exists: false, isDefault: true }),
    createWorkspaceRoot: () => settle({ path: "(no filesystem)", exists: false, isDefault: true }),

    setTabModel: () => settle(undefined),

    async cancelRun(projectId) {
      for (let i = running.length - 1; i >= 0; i--) {
        if (running[i].projectId !== projectId) continue;
        emit("task:finished", finishTask(running.splice(i, 1)[0], false));
      }
      emit("run:stopped", { projectId, stop: "canceled", exitCode: null });
      return settle(undefined);
    },

    listRunningTasks: (projectId) => settle(running.filter((task) => task.projectId === projectId)),

    async cancelTask(toolCallId) {
      const index = running.findIndex((task) => task.toolCallId === toolCallId);
      if (index < 0) return settle(undefined);
      emit("task:finished", finishTask(running.splice(index, 1)[0], false));
      return settle(undefined);
    },

    listTaskLog: (projectId, limit, before) => {
      let rows = taskLog
        .filter((entry) => entry.projectId === projectId)
        .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
      if (before) rows = rows.filter((entry) => entry.finishedAt < before);
      return settle({ entries: rows.slice(0, limit), total: logTotals[projectId] ?? rows.length });
    },

    async clearTaskLog(projectId) {
      for (let i = taskLog.length - 1; i >= 0; i--) {
        if (taskLog[i].projectId === projectId) taskLog.splice(i, 1);
      }
      logTotals[projectId] = 0;
      return settle(undefined);
    },

    /*
     * Always empty, never invented. The raw exchange is only meaningful when
     * there is a real agent on the other end of it, and a fabricated one would
     * be indistinguishable from a real one in exactly the panel someone opens
     * to find out what really happened.
     */
    listAgentIo: (_projectId: string) => settle([] as AgentIoEntry[]),

    // The mock has no store to record into, so it reports the honest default.
    getIoPersist: (_projectId: string) => settle(false),
    setIoPersist: (_projectId: string, enabled: boolean) => settle(enabled),

    /*
     * `supported: false`, never an empty-but-supported report. The mock cannot
     * ask anyone, and claiming "no limits in force" would be the one wrong
     * answer here.
     */
    /*
     * Every agent reports `supported: false`, never an empty-but-supported
     * report. The mock cannot ask anyone, and claiming "no limits in force"
     * would be the one wrong answer here.
     */
    listQuota: () =>
      settle({
        agents: (["claude", "codex", "copilot"] as const).map((agent) => ({
          agent,
          supported: false,
          windows: [],
          plan: null,
          creditBalance: null,
          unlimited: false,
          detail: "the fixture backend cannot ask a provider",
        })),
        checkedAt: new Date().toISOString(),
      } as QuotaReport),

    listRateLimits: () =>
      settle(
        Object.entries(fixtures.RATE_LIMITS).map(([projectId, limit]) => ({ projectId, ...limit })),
      ),

    // A fixture session id, so the design shows the faded "session" line the
    // way a real first prompt would produce it.
    getTaskManager: () => settle({ sessionId: taskManagerSession }),

    async resetTaskManager() {
      taskManagerSession = null;
      return settle(undefined);
    },

    // The mock never runs an agent, so nothing ever asks; answering is a no-op
    // kept only so the interface stays whole.
    resolveApproval: () => settle(undefined),

    // A couple of fixture rules so the "remembered approvals" surface is
    // reviewable in the browser preview.
    listApprovalRules: () => settle(["Bash: cargo test", "Edit: apps/gui/src"]),
    clearApprovalRules: () => settle(undefined),

    // Fixture spend, so the Settings section is reviewable with real-looking
    // numbers. The Rust command sums the usage-ledger table.
    getCostSummary: () =>
      settle({ todayUsd: 0.41, weekUsd: 3.87, monthUsd: 11.02, totalUsd: 28.6, turns: 412 }),

    // A fixture stamp, shaped like the real one so the Settings row renders.
    getBuildInfo: () =>
      settle({ version: "0.1.0", gitSha: "fixture00", builtAt: "2026-07-30 00:00:00" }),

    // A fixture update, so the nudge and the install row are reviewable in
    // the browser preview. The real command asks the CDN manifest.
    checkForUpdate: () =>
      settle({ version: "0.2.0", notes: "Fixture release notes.", date: "2026-07-30" }),
    installUpdate: () => settle(undefined),

    // A browser tab cannot exec itself; the button is greyed off-Tauri anyway.
    relaunchApp: () => settle(undefined),

    async on<E extends keyof AppEvents>(
      event: E,
      handler: (payload: AppEvents[E]) => void,
    ): Promise<Unlisten> {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(handler as (payload: unknown) => void);
    },
  };

  /** A cancelled RunningTask becomes a failed log entry, same as a real one would. */
  function finishTask(task: RunningTask, ok: boolean): TaskLogEntry {
    const entry: TaskLogEntry = {
      id: nextId("log"),
      toolCallId: task.toolCallId,
      projectId: task.projectId,
      itemId: task.itemId,
      label: task.label,
      tool: task.name,
      ok,
      output: ok ? "" : "canceled",
      durationMs: Date.now() - Date.parse(task.startedAt),
      exitCode: ok ? 0 : null,
      finishedAt: new Date().toISOString(),
    };
    taskLog.unshift(entry);
    logTotals[task.projectId] = (logTotals[task.projectId] ?? 0) + 1;
    return entry;
  }
}
