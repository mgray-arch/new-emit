/**
 * Decide whether two places are the same dock.
 * Street suffixes, suite words, case, and punctuation are folded together.
 * A fuzzy company name only counts when the street and city already agree.
 */

export interface AddressLike {
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

const SUFFIX: Record<string, string> = {
  street: "st",
  st: "st",
  road: "rd",
  rd: "rd",
  avenue: "ave",
  ave: "ave",
  av: "ave",
  boulevard: "blvd",
  blvd: "blvd",
  drive: "dr",
  dr: "dr",
  lane: "ln",
  ln: "ln",
  court: "ct",
  ct: "ct",
  place: "pl",
  pl: "pl",
  parkway: "pkwy",
  pkwy: "pkwy",
  pky: "pkwy",
  highway: "hwy",
  hwy: "hwy",
  circle: "cir",
  cir: "cir",
  trail: "trl",
  trl: "trl",
  terrace: "ter",
  ter: "ter",
  suite: "ste",
  ste: "ste",
  apartment: "apt",
  apt: "apt",
  unit: "unit",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  n: "n",
  s: "s",
  e: "e",
  w: "w",
};

function tokens(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[#.,]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeStreet(address1: string | null | undefined, address2?: string | null): string {
  return tokens(`${address1 ?? ""} ${address2 ?? ""}`)
    .map((token) => SUFFIX[token] ?? token)
    .join(" ");
}

export function normalizeCompany(name: string | null | undefined): string {
  const dropped = new Set(["llc", "inc", "incorporated", "co", "company", "corp", "corporation", "ltd", "limited"]);
  return tokens(name)
    .filter((token) => !dropped.has(token))
    .join(" ");
}

export function zip5(postalCode: string | null | undefined): string {
  return (postalCode ?? "").replace(/\D/g, "").slice(0, 5);
}

export function addressKey(place: AddressLike): string {
  const street = normalizeStreet(place.address1, place.address2);
  const city = tokens(place.city).join("");
  const state = tokens(place.state).join("");
  return [street, city, state, zip5(place.postalCode)].join("|");
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[] = Array.from({ length: rows * cols }, () => 0);
  for (let i = 0; i < rows; i += 1) matrix[i * cols] = i;
  for (let j = 0; j < cols; j += 1) matrix[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i * cols + j] = Math.min(
        matrix[(i - 1) * cols + j] + 1,
        matrix[i * cols + (j - 1)] + 1,
        matrix[(i - 1) * cols + (j - 1)] + cost,
      );
    }
  }
  const distance = matrix[rows * cols - 1];
  return 1 - distance / Math.max(left.length, right.length);
}

export function companySimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeCompany(a);
  const right = normalizeCompany(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;
  return similarity(left, right) >= 0.86;
}

export type MatchStrength = "exact" | "likely";

/** Exact means the normalized street, city, state, and ZIP are the same. Likely means the company and street agree. */
export function matchStrength(a: AddressLike, b: AddressLike): MatchStrength | null {
  const streetA = normalizeStreet(a.address1, a.address2);
  const streetB = normalizeStreet(b.address1, b.address2);
  if (!streetA || !streetB || streetA !== streetB) return null;
  const city = tokens(a.city).join("") === tokens(b.city).join("") && tokens(a.city).join("").length > 0;
  const state = tokens(a.state).join("") === tokens(b.state).join("") && tokens(a.state).join("").length > 0;
  if (!city || !state) return null;
  const zipA = zip5(a.postalCode);
  const zipB = zip5(b.postalCode);
  if (zipA && zipB && zipA === zipB) return "exact";
  if (zipA && zipB && zipA !== zipB) return companySimilar(a.company, b.company) ? "likely" : null;
  if (companySimilar(a.company, b.company)) return "likely";
  return null;
}

export function isLikelyDuplicate(a: AddressLike, b: AddressLike): boolean {
  return matchStrength(a, b) !== null;
}
