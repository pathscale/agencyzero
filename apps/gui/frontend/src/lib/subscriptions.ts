/** A listener registration which resolves to its teardown callback. */
export type SubscriptionFactory<Teardown extends () => void = () => void> = () => Promise<Teardown>;

/**
 * Install independent event subscriptions concurrently.
 *
 * Registration is a transport round trip in the native app. Starting each
 * one only after the previous acknowledgement turns a fixed set of listeners
 * into seconds of startup latency. Factories are invoked together, while the
 * caller still receives an all-or-nothing result: if one registration fails,
 * every listener which did install is removed before the error escapes.
 */
export async function installSubscriptions<Teardown extends () => void>(
  factories: readonly SubscriptionFactory<Teardown>[],
): Promise<Teardown[]> {
  const settled = await Promise.allSettled(factories.map((subscribe) => subscribe()));
  const installed: Teardown[] = [];
  let failed = false;
  let failure: unknown;

  for (const result of settled) {
    if (result.status === "fulfilled") installed.push(result.value);
    else if (!failed) {
      failed = true;
      failure = result.reason;
    }
  }

  if (failed) {
    for (const teardown of installed) {
      try {
        teardown();
      } catch {
        // Preserve the registration failure which made this batch unusable.
      }
    }
    throw failure;
  }

  return installed;
}
