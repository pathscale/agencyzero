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
