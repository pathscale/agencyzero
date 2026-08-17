import type { Message } from "~/types";

/**
 * Stable display numbers for persisted agent replies.
 *
 * One provider run is one turn. Owner follow-ups injected while that run is
 * active do not increment it; each durable `continued` slice and the terminal
 * reply become decimal chunks of the same turn. The result is derived from the
 * transcript, so it survives reload without another persisted counter.
 */
export function agentTurnLabels(messages: Message[]): Record<string, string> {
  const labels: Record<string, string> = {};
  let turn = 0;
  let runOpen = false;
  let agentChunks: Message[] = [];

  const finish = (): void => {
    if (agentChunks.length === 0) return;
    const chunked = agentChunks.length > 1 || agentChunks[0].stop === "continued";
    for (const [index, message] of agentChunks.entries()) {
      labels[message.id] = chunked ? `${turn}.${index + 1}` : String(turn);
    }
    agentChunks = [];
  };

  for (const message of messages) {
    if (message.author === "user") {
      if (!runOpen) {
        turn += 1;
        runOpen = true;
      }
      continue;
    }
    if (message.author !== "agent") continue;
    // Old imported transcripts may begin with an agent row. Give it a useful
    // number instead of depending on history that is not in this store.
    if (!runOpen) {
      turn += 1;
      runOpen = true;
    }
    agentChunks.push(message);
    if (message.stop !== "continued") {
      finish();
      runOpen = false;
    }
  }
  finish();
  return labels;
}

/**
 * What the reply being written right now will be numbered.
 *
 * `agentTurnLabels` keys off message ids, and a streaming reply has none: it is
 * never persisted, and is replaced by the real row when the run lands. So the
 * live bubble had no number at all and read as `claude · writing…` while every
 * finished reply above it carried `Turn 26 · …`. The number is knowable during
 * the run — it is the turn the owner's last message opened — so withholding it
 * until the run finishes hides something already determined.
 *
 * Counted the same way `agentTurnLabels` counts, so the number the live bubble
 * shows is the one the persisted row inherits rather than a parallel guess.
 */
export function streamingTurnNumber(messages: Message[]): number {
  let turn = 0;
  let runOpen = false;

  for (const message of messages) {
    if (message.author === "user") {
      if (!runOpen) {
        turn += 1;
        runOpen = true;
      }
      continue;
    }
    if (message.author !== "agent") continue;
    if (!runOpen) {
      turn += 1;
      runOpen = true;
    }
    if (message.stop !== "continued") runOpen = false;
  }

  // A run whose owner message is already in the transcript continues that turn;
  // one streaming ahead of it opens the next.
  return runOpen ? turn : turn + 1;
}
