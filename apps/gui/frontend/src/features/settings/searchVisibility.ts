/**
 * Whether a settings section shows itself, and whether it keeps the retention
 * it earned, while the search corpus is being rebuilt.
 *
 * The corpus is keyed by interface language (`${locale}:${id}`) and learned
 * once per section, so changing language retracts every section's index at the
 * same instant. That is the case these two answers exist for, and getting it
 * wrong is not theoretical: with a query still in the search box, a Chinese
 * round trip made the Codex import picker unreachable. ps-qa navigated to it,
 * logged that it had revealed the control, and then could not find it.
 *
 * Pure, and separate from `SettingsTab.tsx`, because the component cannot be
 * mounted under test: the suite runs on `node` with no DOM, and
 * `vitest.config.ts` records that mounting `SettingsTab` halts the reactive
 * system mid-boot. The decision is a property of these four inputs, so it is
 * testable as one.
 */

/** What the section knows when it decides whether to show itself. */
export type SectionSearchState = {
  /** The trimmed contents of the settings search box. */
  query: string;
  /** Whether the section's own title or hint answers the query. */
  titleMatches: boolean;
  /** How many of the section's rows have reported a match so far. */
  hits: number;
  /** Whether the section's control tree is built. */
  mounted: boolean;
  /**
   * The section's indexed words for the *current* language, or `undefined`
   * when it has not been indexed yet under that key.
   */
  indexedCorpus: string | undefined;
};

/**
 * Whether the section is on screen.
 *
 * `hits === 0` has two meanings and only one of them is "nothing matches". The
 * other is "no row has reported yet", which is the state every section passes
 * through while it re-indexes after a language change. Hiding on that is what
 * made a matching section vanish, so a mounted section with no corpus for the
 * current language stays visible; it settles an instant later when its rows
 * report, and the ordinary predicate takes over.
 */
export function sectionIsVisible(state: SectionSearchState): boolean {
  if (state.query === "") return true;
  if (state.titleMatches || state.hits > 0) return true;
  return state.mounted && state.indexedCorpus === undefined;
}
