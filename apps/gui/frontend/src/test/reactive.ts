import { createRoot } from "solid-js";
import { afterEach } from "vitest";
import { createWorkspace, type Workspace } from "~/stores/workspace";

const roots = new Set<() => void>();

/** Build the application store in Solid's real reactive runtime, without a DOM. */
export async function bootWorkspace(): Promise<Workspace> {
  let dispose!: () => void;
  const workspace = createRoot((rootDispose) => {
    dispose = rootDispose;
    return createWorkspace();
  });
  roots.add(dispose);
  await workspace.init();
  return workspace;
}

/** Retry an asynchronous state assertion without importing a DOM test library. */
export async function waitFor(
  assertion: () => void,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 5;
  const deadline = Date.now() + timeout;
  let failure: unknown;

  do {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  } while (Date.now() < deadline);

  throw failure;
}

afterEach(() => {
  for (const dispose of roots) dispose();
  roots.clear();
});
