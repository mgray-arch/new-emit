/** Confirm copy for removing a portal load. It does not name an outside system. */
export function deleteConfirmText(order: {
  salesOrderNumber?: string | null;
  loadNumber?: string | null;
}): string {
  const sales = order.salesOrderNumber?.trim() || "No sales order";
  const load = order.loadNumber?.trim() || "no load number yet";
  return `Delete ${sales} (Select load ${load})? This removes the load from the portal. Confirm to delete it.`;
}
