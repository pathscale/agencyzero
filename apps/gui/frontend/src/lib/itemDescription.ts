import { tx } from "~/stores/i18n";
import type { ProjectItem } from "~/types";

/** Suggested structure for a fresh focused run; never persisted until saved. */
export function defaultItemDescription(item: ProjectItem): string {
  return `${item.title}\n\n${tx("Details / sub-items")}\n- [ ] ${tx("Complete the work")}\n- [ ] ${tx(
    "Report verification and anything still open",
  )}`;
}
