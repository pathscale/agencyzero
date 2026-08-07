export const ITEM_REFERENCE_EVENT = "agencyzero:item-reference";

const ITEM_ID = /^item-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isItemId(value: string): boolean {
  return ITEM_ID.test(value);
}

export function itemReferenceLabel(id: string): string {
  return `Item-...${id.slice(-12)}`;
}

export function revealItemReference(id: string): void {
  window.dispatchEvent(new CustomEvent(ITEM_REFERENCE_EVENT, { detail: { id } }));
}
