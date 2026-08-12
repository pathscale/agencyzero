/*
 * Dumps the transcript's real markup to a file, so the engine can be tested
 * against what the app actually builds.
 *
 * Two attempts to reproduce the owner's "text spills past its container"
 * screenshot with hand-written fixtures both passed, which proved the fixtures
 * wrong rather than the engine right: a bubble's width comes from a chain of
 * flex items, percentages and min-width rules that nobody reconstructs
 * correctly from memory. This renders the real components against a thread
 * derived from the owner's own store, with every letter and digit replaced and
 * word lengths, line breaks, punctuation and message lengths preserved, and
 * writes the result where `blitz-tests` can load it.
 *
 * It is a generator, not an assertion. It fails only if the markup cannot be
 * produced at all.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { WorkspaceProvider } from "~/stores/workspace";
import type { Message, Project } from "~/types";
import thread from "./__fixtures__/real-thread.json";

const PROJECT: Project = {
  id: "fixture",
  name: "Fixture",
  status: "active",
  order: 0,
  dirs: [],
  pinned: false,
  moderatorEnabled: false,
  forkedFrom: null,
  sessionId: null,
  sessions: {},
  lastActivityAt: "2026-08-10T00:00:00Z",
};

// From the frontend package root (vitest's cwd) up to ~/code, then across into
// the renderer checkout that consumes it.
const OUT = resolve(
  process.cwd(),
  "../../../../ps-blitz/tests/blitz-tests/fixtures/transcript.html",
);

describe("the transcript's markup, as the engine receives it", () => {
  it("writes a fixture built from a real thread with the words replaced", () => {
    const messages = thread as unknown as Message[];
    const { container } = render(() => (
      <WorkspaceProvider>
        <TranscriptPane project={PROJECT} messages={messages} streaming="" />
      </WorkspaceProvider>
    ));

    const markup = container.innerHTML;
    expect(markup.length).toBeGreaterThan(1_000);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, markup, "utf8");
  });
});
