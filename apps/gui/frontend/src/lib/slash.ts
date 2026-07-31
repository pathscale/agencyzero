/**
 * Slash commands, parsed before anything reaches an agent.
 *
 * Two families, and the difference is the whole design.
 *
 * **App-local** commands change this window's state — the model a tab uses, its
 * reasoning effort, its permission posture. They are settings you would
 * otherwise reach for with the mouse, and typing is faster mid-thought than
 * hunting a pill. Nothing is sent to the agent, so they cost nothing and cannot
 * fail halfway.
 *
 * **Agent-session** commands ask the CLI to do something to its own
 * conversation. `/compact` is the example: it is a Claude Code REPL feature that
 * rewrites the session's history. This app does not drive the REPL — it spawns
 * non-interactive runs and resumes by session id — and `agent_abstraction`'s
 * `Request` carries no command channel: `prompt`, `system`, `model`, `effort`,
 * `cont`, `extra_args`, and nothing that means "run a command".
 *
 * So a typed `/compact` cannot work today, and the failure would be silent and
 * expensive: the string would go out as the prompt, the model would read the
 * word "compact" as a request, and a turn would be billed for a misunderstanding
 * that looks like the feature not working. It is recognised and refused instead,
 * with the reason — an honest "not yet" beats a plausible wrong answer.
 */

import { PERMISSION_ORDER } from "~/lib/labels";
import type { Permission } from "~/types";

/** What the composer should do with a line that began with a slash. */
export type SlashOutcome =
  | { kind: "none" }
  | { kind: "model"; model: string }
  | { kind: "effort"; effort: string }
  | { kind: "permission"; permission: Permission }
  | { kind: "help"; message: string }
  | { kind: "error"; message: string };

/** Commands that need the agent's own session, which the run path cannot reach. */
const NEEDS_THE_AGENT: Record<string, string> = {
  compact:
    "/compact is a Claude Code REPL command; this app resumes sessions non-interactively and the crate's Request has no command channel. Tracked — it needs agent-abstraction.",
  resume:
    "/resume is the CLI's own session picker. This app already resumes by session id, so there is nothing for it to pick.",
  clear:
    "/clear would drop the CLI's conversation, which this app cannot see. Start a new project for a fresh session.",
};

const HELP = [
  "/model <id> — the model this tab uses",
  "/effort <level> — reasoning level",
  "/permission <posture> — read_only · plan · ask · edit · auto · bypass",
  "/help — this list",
].join("\n");

/**
 * Read a composer line as a command, or decide it is prose.
 *
 * Only a line whose *first* character is a slash counts, and a lone `/` does
 * not: a message can legitimately begin with a path, and `/usr/bin/env` is not
 * a command. An unknown word is an error rather than a silent send, because
 * mistyping `/modle` and watching it go to the agent as text is worse than
 * being told.
 */
export function parseSlash(
  line: string,
  context: { models: string[]; efforts: string[] },
): SlashOutcome {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return { kind: "none" };
  // A path is prose. `/Users/...` and `/etc/hosts` are things people paste.
  if (trimmed.slice(1).includes("/")) return { kind: "none" };

  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = word.toLowerCase();
  const argument = rest.join(" ").trim();

  const unavailable = NEEDS_THE_AGENT[name];
  if (unavailable) return { kind: "error", message: unavailable };

  switch (name) {
    case "help":
      return { kind: "help", message: HELP };

    case "model": {
      if (!argument)
        return { kind: "error", message: `Which model? ${context.models.join(" · ")}` };
      const match = context.models.find((id) => id.toLowerCase() === argument.toLowerCase());
      return match
        ? { kind: "model", model: match }
        : {
            kind: "error",
            message: `No model called "${argument}". This tab offers: ${context.models.join(" · ")}`,
          };
    }

    case "effort": {
      if (context.efforts.length === 0) {
        return { kind: "error", message: "This model establishes no effort ladder." };
      }
      const match = context.efforts.find((level) => level.toLowerCase() === argument.toLowerCase());
      return match
        ? { kind: "effort", effort: match }
        : {
            kind: "error",
            message: `No effort called "${argument}". This model offers: ${context.efforts.join(" · ")}`,
          };
    }

    case "permission": {
      const match = PERMISSION_ORDER.find(
        (posture) => posture.toLowerCase() === argument.toLowerCase(),
      );
      return match
        ? { kind: "permission", permission: match }
        : {
            kind: "error",
            message: `No posture called "${argument}". One of: ${PERMISSION_ORDER.join(" · ")}`,
          };
    }

    default:
      return {
        kind: "error",
        message: `Unknown command "/${name}". Try /help.`,
      };
  }
}
