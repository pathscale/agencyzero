import { ITEM_LADDER } from "~/lib/labels";
import type { ProjectItem, UiPrefs } from "~/types";

export type ItemSortBy = UiPrefs["itemSortBy"];
export type ItemSortDirection = UiPrefs["itemSortDirection"];

/**
 * Sort a copy of an item list using the two compact header toggles.
 *
 * Rows predating activity tracking have no timestamp. They remain after every
 * known-time row, but still follow the selected direction using their durable
 * manual order. Otherwise an all-legacy project makes both time-sort controls
 * appear to do nothing.
 */
export function sortItems(
  source: readonly ProjectItem[],
  by: ItemSortBy,
  direction: ItemSortDirection,
): ProjectItem[] {
  const items = [...source];
  const sign = direction === "asc" ? 1 : -1;
  items.sort((left, right) => {
    if (by === "status") {
      const status = ITEM_LADDER.indexOf(left.status) - ITEM_LADDER.indexOf(right.status);
      return (status === 0 ? left.order - right.order : status) * sign;
    }
    const leftTime = left.updatedAt ?? "";
    const rightTime = right.updatedAt ?? "";
    if (!leftTime && !rightTime) return (left.order - right.order) * sign;
    if (!leftTime) return 1;
    if (!rightTime) return -1;
    const time = leftTime.localeCompare(rightTime);
    return (time === 0 ? left.order - right.order : time) * sign;
  });
  return items;
}
