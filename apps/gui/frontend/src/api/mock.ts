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
  Question,
  QuotaReport,
  RunningTask,
  StudySummary,
  TaskLogEntry,
} from "~/types";
import {
  type AgencyZeroApi,
  type AppEvents,
  type DeepPartial,
  NOTES_BUDGET,
  type Unlisten,
} from "./client";
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
  let studyEventCount = 0;
  const pullRequests = clone(fixtures.PULL_REQUESTS);
  const questions: Question[] = clone(fixtures.QUESTIONS);
  /*
   * What a project's agent kept across a compaction, per project.
   *
   * Starts empty for every project rather than seeded from a fixture: notes
   * exist only where a compaction has happened, and a mock that shipped
   * pre-written rules would show the panel in a state no fresh install reaches.
   */
  const notes = new Map<string, string>();
  /*
   * Which projects sample their knowledge as the context fills. Off everywhere
   * to start, as on a real install — and the mock never runs an agent, so
   * turning it on here changes the switch and nothing else.
   */
  const checkpoints = new Set<string>();
  /** Projects whose turns carry the concise-response instruction. */
  const responseVerbosity = new Map<string, string>();
  const verbosityByProject = new Map<string, string>();

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

    getHomeSnapshot: () => {
      const turnCounts = messages.reduce<Record<string, number>>((counts, message) => {
        if (message.author === "agent" && message.stop !== "continued") {
          counts[message.projectId] = (counts[message.projectId] ?? 0) + 1;
        }
        return counts;
      }, {});
      return settle({ items, turnCounts });
    },

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
        sessions: {},
        lastActivityAt: new Date().toISOString(),
      };
      projects.push(project);

      const first: Message = {
        id: nextId("message"),
        projectId: project.id,
        itemId: null,
        author: "user",
        agent: input.agent ?? settings.defaultAgent,
        moderation: null,
        model: input.model ?? settings.models[input.agent ?? settings.defaultAgent].default,
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

    async forkItem(itemId) {
      const sourceItem = findItem(itemId);
      const existing = projects.find((project) => project.forkedFrom?.itemId === itemId);
      if (existing) return settle(existing);
      const source = findProject(sourceItem.projectId);
      const fork: Project = {
        ...clone(source),
        id: nextId("project"),
        name: sourceItem.title,
        order: projects.length,
        pinned: false,
        forkedFrom: { projectId: source.id, itemId },
        sessionId: null,
        sessions: {},
        lastActivityAt: new Date().toISOString(),
      };
      projects.push(fork);
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

    // No git remotes to discover from in the mock; re-announce the project's rows.
    async discoverPullRequests(projectId) {
      for (const pr of pullRequests.filter((candidate) => candidate.projectId === projectId)) {
        emit("pr:updated", pr);
      }
      return settle(undefined);
    },

    async reviewPullRequest(projectId, url, agent) {
      // No real agent in the mock; drop a canned review message so the inline
      // rendering and copy button can be exercised.
      emit("message:appended", {
        id: `msg-review-${Date.now()}`,
        projectId,
        itemId: null,
        author: "review",
        agent,
        moderation: null,
        model: "",
        permission: "",
        usage: null,
        stop: url,
        exitCode: 0,
        body: `Review of ${url} by ${agent}:\n\n- **Looks solid.** One nit: guard the empty case in \`parse()\`.`,
        createdAt: new Date().toISOString(),
      } as unknown as Message);
      return settle(undefined);
    },

    listQuestions: (projectId) =>
      settle(questions.filter((question) => question.projectId === projectId)),

    async answerQuestion(id, answered) {
      const question = questions.find((candidate) => candidate.id === id);
      if (!question) return settle(undefined);
      question.answered = answered;
      emit("question:updated", question);
      return settle(undefined);
    },

    listItems: (projectId) =>
      settle(
        items.filter((item) => item.projectId === projectId).sort((a, b) => a.order - b.order),
      ),

    async createItem(projectId, title) {
      findProject(projectId);
      const siblings = items.filter((item) => item.projectId === projectId);
      const order = siblings.reduce((largest, item) => Math.max(largest, item.order), -1) + 1;
      const item: ProjectItem = {
        id: nextId("item"),
        projectId,
        // Nothing has shipped for a row that was only just created.
        reference: null,
        title,
        status: "pending",
        order,
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

    async setItemIssue(id, url) {
      const item = findItem(id);
      item.reference = `issue:${url}`;
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
      const openQuestions = questions.filter(
        (question) => question.projectId === input.projectId && !question.answered,
      );
      const replyQuestion = input.replyQuestionId
        ? openQuestions.find((question) => question.id === input.replyQuestionId)
        : openQuestions.length === 1
          ? openQuestions[0]
          : undefined;
      if (input.replyQuestionId && !replyQuestion) {
        throw new Error(`question ${input.replyQuestionId} is not open in this project`);
      }
      const message: Message = {
        id: nextId("message"),
        projectId: input.projectId,
        itemId: input.itemId ?? null,
        replyToQuestionId: replyQuestion?.id,
        author: "user",
        agent: input.agent ?? settings.defaultAgent,
        moderation: null,
        model: input.model ?? settings.models[input.agent ?? settings.defaultAgent].default,
        permission: input.permission ?? settings.defaultPermission,
        usage: null,
        stop: "completed",
        exitCode: null,
        body: input.body,
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      emit("message:appended", message);
      // The mock has no provider process, so it can honestly acknowledge only
      // that AgencyZero accepted the row, not that an agent read it.
      emit("message:receipt", {
        projectId: message.projectId,
        messageId: message.id,
        status: "sent",
      });
      if (replyQuestion) {
        replyQuestion.answered = true;
        emit("question:updated", replyQuestion);
      }
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
      const wasEnabled = settings.studyAnalytics.enabled;
      settings = deepMerge(settings, patch);
      if (!wasEnabled && settings.studyAnalytics.enabled) {
        settings.studyAnalytics.sessionId = nextId("study");
        settings.studyAnalytics.enabledAt = new Date().toISOString();
        studyEventCount += 1;
      } else if (wasEnabled && !settings.studyAnalytics.enabled) {
        studyEventCount += 1;
      }
      return settle(settings);
    },

    getStudySummary: () =>
      settle({
        enabled: settings.studyAnalytics.enabled,
        studyId: settings.studyAnalytics.sessionId || null,
        enabledAt: settings.studyAnalytics.enabledAt || null,
        eventCount: studyEventCount,
        firstAt: settings.studyAnalytics.enabledAt || null,
        lastAt: settings.studyAnalytics.enabledAt || null,
      } satisfies StudySummary),

    // The fixture has no filesystem or durable study table. Cancelling is the
    // honest save result rather than inventing a file that does not exist.
    exportStudyEvents: () => settle(null),
    clearStudyEvents: () => {
      if (settings.studyAnalytics.enabled) {
        return Promise.reject(new Error("stop study collection before deleting its stored events"));
      }
      studyEventCount = 0;
      return settle(undefined);
    },

    claudeUsage: () =>
      settle({
        fiveHour: {
          utilization: 31.5,
          resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        },
        sevenDay: {
          utilization: 42,
          resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        },
        sevenDaySonnet: null,
        limits: [],
        checkedAt: new Date().toISOString(),
      }),

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

    // A representative slice of the real table so the preview's cost estimate
    // renders with plausible numbers rather than "no price on file".
    pricingTable: () =>
      settle({
        rows: [
          { key: "opus", input: 5.0, output: 25.0, cacheRead: 0.5 },
          { key: "fable", input: 10.0, output: 50.0, cacheRead: 1.0 },
          { key: "sonnet", input: 3.0, output: 15.0, cacheRead: 0.3 },
          { key: "haiku", input: 1.0, output: 5.0, cacheRead: 0.1 },
          { key: "gpt-5.4-mini", input: 0.75, output: 4.5, cacheRead: 0.075 },
          { key: "gpt-5.6-sol", input: 5.0, output: 30.0, cacheRead: 0.5 },
          { key: "gpt-5.6-terra", input: 2.0, output: 12.0, cacheRead: 0.2 },
          { key: "gpt-5.6-luna", input: 0.2, output: 1.2, cacheRead: 0.02 },
          { key: "gpt-5.5", input: 5.0, output: 30.0, cacheRead: 0.5 },
          { key: "gpt-5.4", input: 2.5, output: 15.0, cacheRead: 0.25 },
        ],
        cacheWriteMultiple: 2.0,
        warnUsd: 0.5,
        highUsd: 2.0,
      }),

    /*
     * There is no database outside Tauri, so this reports the shape without
     * claiming a real path, and `isEditable: false` keeps the browser from
     * offering to move something that does not exist.
     */
    /* Plausible shapes rather than a real walk: there is no store outside Tauri,
     * and the point of the row is the *ordering* — that the log dwarfs the
     * transcript is the thing worth seeing. */
    /* No browser to hand it to outside Tauri; the fixture path says so rather
     * than pretending the click worked. */
    openExternal: () => settle(undefined),

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
    getStoreBackupStatus: () =>
      settle({
        backups: [
          {
            id: "fixture-backup",
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
            bytes: 4_530_000,
            appVersion: "0.2.25",
            compatible: true,
            incompatibility: null,
          },
        ],
        lastOperation: null,
      }),
    createStoreBackup: () =>
      Promise.reject(new Error("the fixture backend has no durable store to back up")),
    selectStoreBackup: () =>
      Promise.reject(new Error("the fixture backend has no durable store to restore")),
    restoreStoreBackup: () =>
      Promise.reject(new Error("the fixture backend has no durable store to restore")),
    /*
     * Cancelled, always. A browser has no native picker to open, and answering
     * with a plausible path would have the fixtures pretending to a filesystem
     * they do not have.
     */
    chooseDataDirectory: () => settle(null),
    // No native panel in the preview; the typed path still works.
    chooseProjectDirectory: () => settle(null),
    // A fixed fixture path: the preview has no OS picker to open.
    chooseAttachments: () => settle(["/tmp/mock-attachment.txt"]),

    /* No filesystem outside Tauri, so this describes the shape and claims nothing. */
    getWorkspaceRoot: () => settle({ path: "(no filesystem)", exists: false, isDefault: true }),
    createWorkspaceRoot: () => settle({ path: "(no filesystem)", exists: false, isDefault: true }),

    async cancelRun(projectId) {
      for (let i = running.length - 1; i >= 0; i--) {
        if (running[i].projectId !== projectId) continue;
        emit("task:finished", finishTask(running.splice(i, 1)[0], false));
      }
      const last = [...messages]
        .reverse()
        .find((message) => message.projectId === projectId && message.author === "user");
      emit("run:stopped", {
        projectId,
        agent: last?.agent ?? "claude",
        model: last?.model ?? "",
        permission: last?.permission ?? "read_only",
        stop: "canceled",
        exitCode: null,
      });
      return settle(undefined);
    },

    /*
     * Refused rather than faked. A compaction rewrites the agent's own
     * conversation, and the mock has no agent and no session: reporting success
     * would put "Compacted the conversation" on screen over a transcript
     * nothing touched, which is the one thing this file refuses to do.
     */
    compactProject: () => Promise.reject(new Error("the mock has no agent session to compact")),

    /*
     * Notes are real here, unlike the compaction that produces them.
     *
     * Nothing is faked: an unwritten project reads empty, which is exactly what
     * the backend returns. Storing what the editor saves is what makes the panel
     * drivable without an agent — the round trip is the behaviour under test,
     * and refusing it would leave the one surface that can correct a bad rule
     * untested everywhere except a live machine.
     */
    getCheckpoints: (projectId) => settle(checkpoints.has(projectId)),
    setCheckpoints: (projectId, enabled) => {
      if (enabled) checkpoints.add(projectId);
      else checkpoints.delete(projectId);
      return settle(enabled);
    },

    getProjectConcise: (projectId) => settle(responseVerbosity.get(projectId) ?? "default"),
    setProjectConcise: (projectId, enabled) => {
      responseVerbosity.set(projectId, enabled);
      return settle(enabled);
    },

    getProjectVerbosity: (projectId) => settle(verbosityByProject.get(projectId) ?? "adaptive"),
    setProjectVerbosity: (projectId, verbosity) => {
      verbosityByProject.set(projectId, verbosity);
      return settle(undefined);
    },

    resetProjectSession: (_projectId, _agent, _force) => settle(undefined),
    adoptSession: (_projectId, _agent, _sessionId) => settle(undefined),

    getProjectNotes: (projectId) => settle(notes.get(projectId) ?? ""),
    setProjectNotes: (projectId, text) => {
      // Clamped as the backend clamps, so the editor's budget behaviour is the
      // same on both.
      const kept = text.trim().slice(0, NOTES_BUDGET);
      notes.set(projectId, kept);
      return settle(kept);
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
    getTaskManager: () =>
      settle({ agent: settings.taskManager.agent, sessionId: taskManagerSession }),

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

    // Fixture usage decomposition for the Analytics view, oldest to newest.
    // Cache reads dominate on a healthy day (the conversation is re-sent and
    // mostly hit); Aug 3 is a deliberate cache-miss day where writes spike and
    // the read:write ratio collapses, so the efficiency panel has something to
    // warn about.
    getUsageAnalytics: () =>
      settle({
        days: [
          {
            day: "2026-08-01",
            costUsd: 1.82,
            inputTokens: 42_000,
            outputTokens: 18_500,
            cacheReadTokens: 610_000,
            cacheWriteTokens: 54_000,
            estimatedCacheWriteTokens: 0,
            turns: 61,
          },
          {
            day: "2026-08-02",
            costUsd: 2.14,
            inputTokens: 51_300,
            outputTokens: 22_100,
            cacheReadTokens: 742_000,
            cacheWriteTokens: 61_000,
            estimatedCacheWriteTokens: 0,
            turns: 73,
          },
          {
            day: "2026-08-03",
            costUsd: 3.96,
            inputTokens: 88_400,
            outputTokens: 31_900,
            cacheReadTokens: 190_000,
            cacheWriteTokens: 72_000,
            estimatedCacheWriteTokens: 50_000,
            turns: 84,
          },
          {
            day: "2026-08-04",
            costUsd: 1.57,
            inputTokens: 39_800,
            outputTokens: 16_400,
            cacheReadTokens: 588_000,
            cacheWriteTokens: 47_000,
            estimatedCacheWriteTokens: 20_000,
            turns: 55,
          },
          {
            day: "2026-08-05",
            costUsd: 2.31,
            inputTokens: 47_600,
            outputTokens: 20_800,
            cacheReadTokens: 690_000,
            cacheWriteTokens: 34_000,
            estimatedCacheWriteTokens: 48_000,
            turns: 68,
          },
        ],
        models: [
          {
            model: "claude-opus-4",
            costUsd: 8.94,
            inputTokens: 201_000,
            outputTokens: 84_300,
            cacheReadTokens: 1_720_000,
            cacheWriteTokens: 268_000,
            estimatedCacheWriteTokens: 0,
            turns: 214,
          },
          {
            model: "gpt-5.6-sol",
            costUsd: 2.86,
            inputTokens: 68_100,
            outputTokens: 25_400,
            cacheReadTokens: 1_100_000,
            cacheWriteTokens: 0,
            estimatedCacheWriteTokens: 118_000,
            turns: 127,
          },
        ],
        projects: [
          {
            projectId: "project-alpha",
            projectName: "AgencyZero",
            costUsd: 8.94,
            inputTokens: 181_000,
            outputTokens: 79_000,
            cacheReadTokens: 2_100_000,
            cacheWriteTokens: 244_000,
            estimatedCacheWriteTokens: 0,
            turns: 239,
          },
          {
            projectId: "project-beta",
            projectName: "Release research",
            costUsd: 2.86,
            inputTokens: 88_100,
            outputTokens: 30_700,
            cacheReadTokens: 720_000,
            cacheWriteTokens: 24_000,
            estimatedCacheWriteTokens: 118_000,
            turns: 102,
          },
        ],
        sessions: [
          {
            projectId: "project-alpha",
            projectName: "AgencyZero",
            agent: "claude",
            sessionId: "6bd1286f-77c0-4c50-ab3a-4997e400859d",
            model: "claude-opus-4",
            costUsd: 1.39,
            inputTokens: 18_200,
            outputTokens: 7_800,
            cacheReadTokens: 622_000,
            cacheWriteTokens: 31_000,
            estimatedCacheWriteTokens: 0,
            processedTokens: 679_000,
            turns: 12,
            lastAt: "2026-08-05T14:22:07.000Z",
          },
        ],
        agents: [
          {
            agent: "claude",
            reportedCostUsd: 8.94,
            estimatedCostUsd: 0,
            effectiveCostUsd: 8.94,
            completedItems: 6,
            costPerCompletedItem: 1.49,
            processedTokens: 2_704_000,
            turns: 214,
          },
          {
            agent: "codex",
            reportedCostUsd: 0,
            estimatedCostUsd: 2.86,
            effectiveCostUsd: 2.86,
            completedItems: 9,
            costPerCompletedItem: 0.317_777,
            processedTokens: 880_800,
            turns: 127,
          },
        ],
        totalUsd: 11.8,
        estimatedCostUsd: 2.86,
        totalInputTokens: 269_100,
        totalOutputTokens: 109_700,
        totalCacheReadTokens: 2_820_000,
        totalCacheWriteTokens: 268_000,
        estimatedCacheWriteTokens: 118_000,
        totalProcessedTokens: 3_466_800,
        largestTurn: {
          at: "2026-08-05T14:22:07.000Z",
          model: "claude-opus-4",
          inputTokens: 4_200,
          cacheReadTokens: 182_000,
          cacheWriteTokens: 9_100,
          estimatedCacheWriteTokens: 0,
          outputTokens: 3_400,
          processedTokens: 198_700,
          costUsd: 0.61,
        },
        turns: 341,
        reconstructedTurns: 28,
        importedTurns: 31,
      }),
    discoverChatImports: () =>
      settle([
        {
          source: "claude-code",
          label: "Claude Code",
          available: true,
          note: "2 importable local sessions",
          sessions: [
            {
              id: "fixture-session",
              title: "Imported fixture conversation",
              updatedAt: "2026-08-07T00:00:00Z",
              messages: 12,
              importable: true,
            },
            {
              id: "cloud-only",
              title: "Cloud-only session",
              updatedAt: new Date().toISOString(),
              messages: 8,
              importable: false,
            },
            {
              id: "fixture-session-2",
              title: "Another fixture conversation",
              updatedAt: "2026-08-06T00:00:00Z",
              messages: 8,
              importable: true,
            },
          ],
        },
      ]),
    importChatSession: () => settle(clone(projects[0])),

    // A fixture stamp, shaped like the real one so the Settings row renders.
    getBuildInfo: () =>
      settle({ version: "0.1.0", gitSha: "fixture00", builtAt: "2026-07-30 00:00:00" }),

    // A fixture update, so the nudge and the install row are reviewable in
    // the browser preview. The real command asks the CDN manifest.
    checkForUpdate: () =>
      settle({ version: "0.2.0", notes: "Fixture release notes.", date: "2026-07-30" }),
    installUpdate: () => settle(undefined),

    // A browser preview has no native process to quit.
    quitApp: () => settle(undefined),

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
