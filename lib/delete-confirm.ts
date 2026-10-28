/** Confirm copy for deleting a portal order. Deleting here does not change SAM. */
export function deleteConfirmText(loadNumber: string | null | undefined): string {
  const base = "Delete this order? This cannot be undone. It does not change SAM.";
  if (loadNumber?.trim()) return `${base} The SAM load must be voided separately in SAM.`;
  return base;
}
