import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

/**
 * The webview's half of the log file.
 *
 * A bundled `.app` discards stderr, and it has no devtools either, so a boot
 * that stalls in JavaScript leaves nothing at all behind — no console, no
 * stderr, no file. Every line here is forwarded to Rust's `log_frontend`, which
 * writes it to the same file as the Rust ones. **One interleaved file is the
 * point**: when a boot hangs, the only question that matters is whether Rust
 * was ever asked, and two separate logs cannot answer it.
 *
 * Outside Tauri this is the console, so `bun run dev` reads normally.
 */

type Level = "debug" | "info" | "warn" | "error";

/**
 * Forwarding is fire-and-forget and can never throw.
 *
 * A logger that rejects would turn a diagnostic into a second failure, and one
 * that rejects *unhandled* would trip the very handler installed below and
 * recurse. Both are why this swallows.
 */
function forward(level: Level, message: string): void {
  if (!isTauri()) {
    // biome-ignore lint/suspicious/noConsole: outside Tauri the console is the log.
    console[level === "debug" ? "log" : level](`[az] ${message}`);
    return;
  }
  void invoke("log_frontend", { level, message }).catch(() => {
    // Nothing useful to do: the log itself is what failed.
  });
}

export const log = {
  debug: (message: string) => forward("debug", message),
  info: (message: string) => forward("info", message),
  warn: (message: string) => forward("warn", message),
  error: (message: string) => forward("error", message),
};

/** Render anything thrown into one line, since only a string crosses the IPC. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * Route what the webview would otherwise only whisper to a console nobody can
 * open: uncaught errors and unhandled rejections.
 *
 * Called once at startup. Idempotent, because a second registration would
 * double every line.
 */
let installed = false;
export function installGlobalErrorLogging(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    log.error(`uncaught ${describeError(event.error ?? event.message)}${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    log.error(`unhandled rejection: ${describeError(event.reason)}`);
  });
}
