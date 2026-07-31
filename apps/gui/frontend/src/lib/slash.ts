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
 * conversation. `/compact` is the example: it rewrites the session's history
 * into a summary, which is the only answer to a context window that has filled
 * up and taken the model's judgement with it.
 *
 * These used to be refused here, because sending the literal would have been
 * worse than refusing: the string goes out as the prompt, the model reads the
 * word as a request, and a turn is billed for a misunderstanding that looks
 * exactly like the feature not working. `agent-abstraction` 0.4.1 added the
 * command channel that was missing, so `/compact` now runs as a real command
 * against the session and this file routes it there.
 *
 * The rest stay refused, and for their own reasons rather than a shared one:
 * `/resume` is the CLI's own session picker and this app already resumes by id,
 * `/clear` would drop a conversation the transcript would go on showing.
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
  /** Run the agent's own `/compact` against this project's session. */
  | { kind: "compact" }
  | { kind: "error"; message: string };

/** Commands that need the agent's own session, which the run path cannot reach. */
const NEEDS_THE_AGENT: Record<string, string> = {
  resume:
    "/resume is the CLI's own session picker. This app already resumes by session id, so there is nothing for it to pick.",
  clear:
    "/clear would drop the CLI's conversation, which this app cannot see. Start a new project for a fresh session.",
};

const HELP = [
  "/model <id> — the model this tab uses",
  "/effort <level> — reasoning level",
  "/permission <posture> — read_only · plan · ask · edit · auto · bypass",
  "/compact — summarise this conversation so the model stops running out of room",
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

    // Handed to the backend rather than answered here: it is a real turn
    // against the agent's own session, not a change to this tab's state.
    case "compact":
      return { kind: "compact" };

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
