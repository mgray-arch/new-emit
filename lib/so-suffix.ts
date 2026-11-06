import { normalizeSalesOrder, salesOrderError } from "@/lib/sales-orders";

/**
 * T-suffix helpers for copied loads. A bare sales order counts as T1, so the
 * first suggestion is base_T2. Only a trailing _T plus digits is a suffix:
 * SO_TX_5 and SO_T are unsuffixed. Stored values are uppercase.
 */
export interface SplitSuffix {
  base: string;
  /** Null when the value has no trailing _T suffix. A bare base is not T0. */
  n: number | null;
}

export interface SuffixSuggestion {
  base: string;
  /** The value that set the high-water mark, such as "_T2" or the bare SO. Null when nothing is in use. */
  highestInUse: string | null;
  suggestion: string | null;
  /** True when the next suffix would fail sales-order validation, including the 40-character limit. */
  tooLong: boolean;
}

const SUFFIX = /^(.*?)_T(\d+)$/;

export function splitSuffix(so: string): SplitSuffix {
  const value = normalizeSalesOrder(so);
  const match = SUFFIX.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) return { base: value, n: null };
  const n = Number(match[2]);
  if (!Number.isInteger(n) || n < 0) return { base: value, n: null };
  return { base: match[1], n };
}

/**
 * Next free suffix for a base. `existing` may include the base, `_T` copies,
 * unrelated SOs, and mixed case. A bare base counts as T1. With nothing in
 * use the suggestion is still base_T2, because the unsuffixed number is treated
 * as the original. Gaps are not filled: T2 and T5 suggest T6. `_T02` is 2, and
 * the suggestion is written without zero padding.
 */
export function nextSuffix(baseRaw: string, existing: string[]): SuffixSuggestion {
  const base = splitSuffix(baseRaw).base;
  let max = 0;
  let highestInUse: string | null = null;
  let saw = false;
  for (const raw of existing) {
    const value = normalizeSalesOrder(raw);
    if (!value) continue;
    const split = splitSuffix(value);
    if (split.base !== base) continue;
    saw = true;
    const n = split.n == null ? 1 : split.n;
    if (n >= max) {
      max = n;
      highestInUse = split.n == null ? value : `_T${n}`;
    }
  }
  const suggestion = `${base}_T${saw ? max + 1 : 2}`;
  const tooLong = salesOrderError(suggestion) !== null;
  return {
    base,
    highestInUse: saw ? highestInUse : null,
    suggestion: tooLong ? null : suggestion,
    tooLong,
  };
}
