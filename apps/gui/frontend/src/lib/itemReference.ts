const ITEM_ID = /^item-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ItemReferenceHandler = (id: string) => void;

let itemReferenceHandler: ItemReferenceHandler | undefined;

export function isItemId(value: string): boolean {
  return ITEM_ID.test(value);
}

export function itemReferenceLabel(id: string): string {
  return `Item-...${id.slice(-12)}`;
}

export function setItemReferenceHandler(handler: ItemReferenceHandler): () => void {
  itemReferenceHandler = handler;
  return () => {
    if (itemReferenceHandler === handler) itemReferenceHandler = undefined;
  };
}

export function revealItemReference(id: string): void {
  itemReferenceHandler?.(id);
}
