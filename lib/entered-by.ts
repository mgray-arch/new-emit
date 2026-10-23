/** Select-facing label. Older loads have no stored person, so this does not guess from a name alone. */
export function formatEnteredBy(name: string | null | undefined, email: string | null | undefined): string {
  const person = (name ?? "").trim();
  const address = (email ?? "").trim();
  if (person && address) return `${person} (${address})`;
  if (person) return person;
  if (address) return address;
  return "Unknown";
}
