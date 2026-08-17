/**
 * Every catalogue placeholder is one `tx` can substitute.
 *
 * `tx` replaces `{name}`, single braces. Two strings were written with double
 * braces, so `replaceAll("{recovered}", "4874")` matched the inner half of
 * `{{recovered}}` and left the outer pair behind: the analytics header shipped
 * reading "usage recovered for {4874} of {7892} imported assistant turns", and
 * the cache-write footnote "~{28.7M} of Sol cache writes inferred from".
 *
 * Nothing failed, nothing threw, and the type checker is happy either way,
 * because both spellings are just text. So the catalogue is checked directly.
 */

import { describe, expect, it } from "vitest";
import uiEn from "~/i18n/ui/en";
import uiZh from "~/i18n/ui/zh";

const CATALOGUES: [string, Record<string, string>][] = [
  ["en", uiEn as unknown as Record<string, string>],
  ["zh", uiZh as unknown as Record<string, string>],
];

describe("catalogue placeholders", () => {
  it("uses single braces, which is what tx substitutes", () => {
    for (const [locale, catalogue] of CATALOGUES) {
      for (const [key, message] of Object.entries(catalogue)) {
        expect(
          message,
          `${locale}: "${key}" uses {{double}} braces; tx replaces {single} ` +
            "ones, so the outer pair survives and is printed to the user",
        ).not.toMatch(/\{\{\w+\}\}/);
      }
    }
  });

  /*
   * The mirror of the above: a placeholder that is opened and never closed
   * prints the brace and swallows nothing, which reads as a typo on screen.
   */
  it("closes every placeholder it opens", () => {
    for (const [locale, catalogue] of CATALOGUES) {
      for (const [key, message] of Object.entries(catalogue)) {
        const opens = (message.match(/\{/g) ?? []).length;
        const closes = (message.match(/\}/g) ?? []).length;
        expect(opens, `${locale}: "${key}" has unbalanced braces: ${message}`).toBe(closes);
      }
    }
  });
});
