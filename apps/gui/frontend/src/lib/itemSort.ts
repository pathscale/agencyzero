import { ITEM_LADDER } from "~/lib/labels";
import type { Project, ProjectItem, UiPrefs } from "~/types";

export type ItemSortBy = UiPrefs["itemSortBy"];
export type ItemSortDirection = UiPrefs["itemSortDirection"];
export type HomeSortBy = UiPrefs["homeSortBy"];

/**
 * Home is a project-grouped list, so its sort controls must move both layers.
 * Sorting only the child rows makes the dominant project rows stay fixed and
 * makes the control look inert for projects with one item or collapsed groups.
 */
export function sortProjects(
  source: readonly Project[],
  by: HomeSortBy,
  direction: ItemSortDirection,
  turnCounts: Readonly<Record<string, number>> = {},
): Project[] {
  const projects = [...source];
  const sign = direction === "asc" ? 1 : -1;
  projects.sort((left, right) => {
    if (by === "turns") {
      const turns = (turnCounts[left.id] ?? 0) - (turnCounts[right.id] ?? 0);
      return (turns === 0 ? left.order - right.order : turns) * sign;
    }
    if (by === "status") {
      const status = ITEM_LADDER.indexOf(left.status) - ITEM_LADDER.indexOf(right.status);
      return (status === 0 ? left.order - right.order : status) * sign;
    }
    const leftTime = left.lastActivityAt;
    const rightTime = right.lastActivityAt;
    if (!leftTime && !rightTime) return (left.order - right.order) * sign;
    // Undated rows sink in both directions. These deliberately do not take
    // `sign`: negating them would float a project that has never been touched
    // above genuinely recent ones the moment the sort is reversed, which is
    // the opposite of what "most recent first" means.
    if (!leftTime) return 1;
    if (!rightTime) return -1;
    const time = leftTime.localeCompare(rightTime);
    return (time === 0 ? left.order - right.order : time) * sign;
  });
  return projects;
}

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
