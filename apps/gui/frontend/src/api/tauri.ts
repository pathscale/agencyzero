import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgencyZeroApi, AppEvents, Unlisten } from "./client";

/**
 * The real client: `invoke()` for commands, `listen()` for events.
 *
 * Command names are snake_case because that is what `#[tauri::command]`
 * generates from a Rust fn name; argument keys are camelCase because Tauri
 * converts them to snake_case on the way in. Both halves of that convention
 * are load-bearing — a mismatch fails at runtime, not at build.
 *
 * None of these commands exist in `az-gui` yet. `./index.ts` probes for them
 * and falls back to the mock, so this file is inert until Rust catches up.
 */
export function createTauriApi(): AgencyZeroApi {
  return {
    listProjects: () => invoke("list_projects"),
    createProject: (input) => invoke("create_project", input),
    deleteProject: (id) => invoke("delete_project", { id }),
    setProjectStatus: (id, status) => invoke("set_project_status", { id, status }),
    reorderProjects: (ids) => invoke("reorder_projects", { ids }),
    setProjectPinned: (id, pinned) => invoke("set_project_pinned", { id, pinned }),
    setProjectModerator: (id, enabled) => invoke("set_project_moderator", { id, enabled }),
    forkProject: (projectId, messageId) => invoke("fork_project", { projectId, messageId }),
    addDir: (projectId, path) => invoke("add_dir", { projectId, path }),
    removeDir: (projectId, path) => invoke("remove_dir", { projectId, path }),

    listItems: (projectId) => invoke("list_items", { projectId }),
    createItem: (projectId, title) => invoke("create_item", { projectId, title }),
    deleteItem: (id) => invoke("delete_item", { id }),
    setItemStatus: (id, status) => invoke("set_item_status", { id, status }),
    reorderItems: (projectId, ids) => invoke("reorder_items", { projectId, ids }),

    listMessages: (projectId) => invoke("list_messages", { projectId }),
    sendMessage: (input) => invoke("send_message", input),
    resolveModeration: (messageId, approve) => invoke("resolve_moderation", { messageId, approve }),

    getSettings: () => invoke("get_settings"),
    setSettings: (patch) => invoke("set_settings", { patch }),
    listAgentStatus: (recheck) => invoke("list_agent_status", { recheck }),
    listModels: (discover) => invoke("list_models", { discover }),
    getDataLocation: () => invoke("get_data_location"),
    setDataLocation: (path) => invoke("set_data_location", { path }),

    setTabModel: (tabKey, model, permission) =>
      invoke("set_tab_model", { tabKey, model, permission }),
    cancelRun: (projectId) => invoke("cancel_run", { projectId }),
    listRunningTasks: (projectId) => invoke("list_running_tasks", { projectId }),
    cancelTask: (toolCallId) => invoke("cancel_task", { toolCallId }),
    listTaskLog: (projectId, limit, before) =>
      invoke("list_task_log", { projectId, limit, before }),
    clearTaskLog: (projectId) => invoke("clear_task_log", { projectId }),
    listRateLimits: () => invoke("list_rate_limits"),

    async on<E extends keyof AppEvents>(
      event: E,
      handler: (payload: AppEvents[E]) => void,
    ): Promise<Unlisten> {
      const unlisten = await listen<AppEvents[E]>(event, ({ payload }) => handler(payload));
      return () => unlisten();
    },
  };
}
