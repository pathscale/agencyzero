import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { describeError, log } from "~/lib/log";
import type { AgencyZeroApi, AppEvents, Unlisten } from "./client";

/**
 * The real client: `invoke()` for commands, `listen()` for events.
 *
 * Command names are snake_case because that is what `#[tauri::command]`
 * generates from a Rust fn name; argument keys are camelCase because Tauri
 * converts them to snake_case on the way in. Both halves of that convention
 * are load-bearing — a mismatch fails at runtime, not at build.
 */

/**
 * Every command is logged in and out, with a sequence number pairing the two.
 *
 * A request with no matching reply is exactly what a hung boot looks like from
 * the webview, and it is otherwise indistinguishable from a request that was
 * never made — which cost this app an afternoon of guessing. The pairing is
 * what tells those apart, so do not call `invoke` directly from here.
 */
let sequence = 0;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const id = ++sequence;
  const startedAt = performance.now();
  const took = () => Math.round(performance.now() - startedAt);

  log.debug(`-> ${command} #${id}`);
  try {
    const result = await invoke<T>(command, args);
    log.debug(`<- ${command} #${id} in ${took()}ms`);
    return result;
  } catch (cause) {
    log.error(`!! ${command} #${id} failed after ${took()}ms: ${describeError(cause)}`);
    throw cause;
  }
}

export function createTauriApi(): AgencyZeroApi {
  return {
    listProjects: () => call("list_projects"),
    createProject: (input) => call("create_project", { input }),
    deleteProject: (id) => call("delete_project", { id }),
    renameProject: (id, name) => call("rename_project", { id, name }),
    setProjectStatus: (id, status) => call("set_project_status", { id, status }),
    reorderProjects: (ids) => call("reorder_projects", { ids }),
    setProjectPinned: (id, pinned) => call("set_project_pinned", { id, pinned }),
    setProjectModerator: (id, enabled) => call("set_project_moderator", { id, enabled }),
    forkProject: (projectId, messageId) => call("fork_project", { projectId, messageId }),
    addDir: (projectId, path) => call("add_dir", { projectId, path }),
    removeDir: (projectId, path) => call("remove_dir", { projectId, path }),

    listItems: (projectId) => call("list_items", { projectId }),
    createItem: (projectId, title) => call("create_item", { projectId, title }),
    deleteItem: (id) => call("delete_item", { id }),
    setItemStatus: (id, status) => call("set_item_status", { id, status }),
    updateItem: (id, title) => call("update_item", { id, title }),
    reorderItems: (projectId, ids) => call("reorder_items", { projectId, ids }),

    listMessages: (projectId) => call("list_messages", { projectId }),
    sendMessage: (input) => call("send_message", { input }),
    resolveModeration: (messageId, approve) => call("resolve_moderation", { messageId, approve }),

    getSettings: () => call("get_settings"),
    setSettings: (patch) => call("set_settings", { patch }),
    listAgentStatus: (recheck) => call("list_agent_status", { recheck }),
    listModels: (discover) => call("list_models", { discover }),
    getDataLocation: () => call("get_data_location"),
    setDataLocation: (path) => call("set_data_location", { path }),
    chooseDataDirectory: () => call("choose_data_directory"),
    chooseAttachments: () => call("choose_attachments"),
    getWorkspaceRoot: () => call("get_workspace_root"),
    createWorkspaceRoot: () => call("create_workspace_root"),

    setTabModel: (tabKey, model, permission) =>
      call("set_tab_model", { tabKey, model, permission }),
    cancelRun: (projectId) => call("cancel_run", { projectId }),
    listRunningTasks: (projectId) => call("list_running_tasks", { projectId }),
    cancelTask: (toolCallId) => call("cancel_task", { toolCallId }),
    listTaskLog: (projectId, limit, before) => call("list_task_log", { projectId, limit, before }),
    listAgentIo: (projectId) => call("list_agent_io", { projectId }),
    getIoPersist: (projectId) => call("get_io_persist", { projectId }),
    setIoPersist: (projectId, enabled) => call("set_io_persist", { projectId, enabled }),
    listQuota: () => call("list_quota"),
    clearTaskLog: (projectId) => call("clear_task_log", { projectId }),
    listRateLimits: () => call("list_rate_limits"),
    getCostSummary: () => call("get_cost_summary"),
    getBuildInfo: () => call("get_build_info"),
    checkForUpdate: () => call("check_for_update"),
    installUpdate: () => call("install_update"),
    relaunchApp: () => call("relaunch_app"),
    getTaskManager: () => call("get_task_manager"),
    resetTaskManager: () => call("reset_task_manager"),
    resolveApproval: (projectId, approvalId, allow, remember) =>
      call("resolve_approval", { projectId, approvalId, allow, remember: remember ?? false }),
    listApprovalRules: (projectId) => call("list_approval_rules", { projectId }),
    clearApprovalRules: (projectId) => call("clear_approval_rules", { projectId }),

    async on<E extends keyof AppEvents>(
      event: E,
      handler: (payload: AppEvents[E]) => void,
    ): Promise<Unlisten> {
      const unlisten = await listen<AppEvents[E]>(event, ({ payload }) => handler(payload));
      log.debug(`listening for ${event}`);
      return () => unlisten();
    },
  };
}
