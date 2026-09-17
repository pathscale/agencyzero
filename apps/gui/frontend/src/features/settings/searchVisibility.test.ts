/*
 * @vitest-environment node
 *
 * The decision under test is a predicate over four booleans-worth of state, so
 * it is tested as one. The component it came from cannot be mounted here:
 * `vitest.config.ts` records that mounting `SettingsTab` halts the reactive
 * system mid-boot, which is why this logic lives in its own module.
 */
import { describe, expect, it } from "vitest";
import { type SectionSearchState, sectionIsVisible } from "./searchVisibility";

/** A settled section that answers the query through one of its rows. */
const matching: SectionSearchState = {
  query: "codex",
  titleMatches: false,
  hits: 1,
  mounted: true,
  indexedCorpus: "choose a session from codex cli / ide",
};

describe("a settings section under a live search", () => {
  it("shows itself when a row has answered the query", () => {
    expect(sectionIsVisible(matching)).toBe(true);
  });

  it("hides when it is settled and nothing in it matches", () => {
    expect(sectionIsVisible({ ...matching, hits: 0 })).toBe(false);
  });

  it("shows everything when the search box is empty", () => {
    expect(sectionIsVisible({ ...matching, query: "", hits: 0 })).toBe(true);
  });

  /*
   * The regression. Changing interface language retracts every section's
   * corpus at once, because it is keyed by locale. The section is still
   * mounted and still matches, but no row has reported against the new key
   * yet, so `hits` is momentarily 0. Reading that as "nothing matches" is what
   * made the Codex import picker unreachable after a Chinese round trip: ps-qa
   * revealed the control and then could not find it.
   */
  it("stays visible while it is re-indexing after a language change", () => {
    const reindexing: SectionSearchState = {
      ...matching,
      hits: 0,
      indexedCorpus: undefined,
    };
    expect(sectionIsVisible(reindexing)).toBe(true);
  });

  /*
   * The same emptiness must not keep an unmounted section on screen: with no
   * tree built there is nothing to re-index and nothing to show.
   */
  it("does not show an unmounted section merely for lacking a corpus", () => {
    const unmounted: SectionSearchState = {
      ...matching,
      hits: 0,
      mounted: false,
      indexedCorpus: undefined,
    };
    expect(sectionIsVisible(unmounted)).toBe(false);
  });

  /*
   * Once the rows have reported against the new language and none of them
   * answer, the ordinary predicate takes over and the section hides. The
   * re-index allowance is a window, not a permanent exemption.
   */
  it("hides again once re-indexing settles on no match", () => {
    const settled: SectionSearchState = {
      ...matching,
      hits: 0,
      indexedCorpus: "unrelated words",
    };
    expect(sectionIsVisible(settled)).toBe(false);
  });
});
