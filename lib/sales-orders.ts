/**
 * Sales orders on a load. Each line is one SO and the drop it delivers to.
 * Older loads stored one free-text string, sometimes "SO1, SO2"; those are parsed on read.
 * SOs are upper case everywhere so SAM always receives them in ALL CAPS.
 */
export interface SalesOrderLine {
  number: string;
  /** The drop stop id. Null only when a multi-drop load has not been assigned yet. */
  stopId: string | null;
}

export const SALES_ORDER_MAX = 40;
export const SALES_ORDERS_MAX = 50;

/** One SO: letters, digits, and - _ / . # inside. No spaces, commas, or semicolons. */
const SINGLE_SO = /^[A-Z0-9](?:[A-Z0-9._/#-]*[A-Z0-9])?$/;

export function normalizeSalesOrder(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Null when the value is one valid SO, otherwise the message to show. */
export function salesOrderError(raw: string): string | null {
  const value = normalizeSalesOrder(raw);
  if (!value) return "Enter a sales order number.";
  if (/[\s,;]/.test(value)) return "Enter one sales order per field. Use + to add another.";
  if (value.length > SALES_ORDER_MAX) return `A sales order can be at most ${SALES_ORDER_MAX} characters.`;
  if (!SINGLE_SO.test(value)) return "Use letters, numbers, and - _ / . # only.";
  return null;
}

/** Splits an older single string ("SO1, SO2" or "SO1 SO2") into SOs. Duplicates fold together. */
export function parseLegacySalesOrders(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const value = normalizeSalesOrder(part);
    if (value) seen.add(value);
  }
  return [...seen];
}

export function joinSalesOrders(lines: Array<{ number: string }>): string {
  return lines.map((line) => line.number).join(", ");
}

/**
 * Ties each SO to a real drop. With one drop every SO goes to it. With several drops
 * a stopId that is not a current drop becomes null (unassigned).
 */
export function resolveSalesOrders(
  lines: Array<{ number: string; stopId?: string | null }>,
  stops: Array<{ id: string; kind: string }>,
): SalesOrderLine[] {
  const drops = stops.filter((stop) => stop.kind === "drop").map((stop) => stop.id);
  const seen = new Set<string>();
  const out: SalesOrderLine[] = [];
  for (const line of lines) {
    const number = normalizeSalesOrder(line.number);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    const stopId = drops.length === 1 ? drops[0] : line.stopId && drops.includes(line.stopId) ? line.stopId : null;
    out.push({ number, stopId });
  }
  return out;
}

/** Stored JSON first, then the old string column. */
export function storedSalesOrders(
  json: string | null | undefined,
  legacy: string | null | undefined,
  stops: Array<{ id: string; kind: string }>,
): SalesOrderLine[] {
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        const lines = parsed
          .filter((item) => item && typeof item.number === "string")
          .map((item) => ({ number: item.number as string, stopId: typeof item.stopId === "string" ? item.stopId : null }));
        if (lines.length) return resolveSalesOrders(lines, stops);
      }
    } catch {
      /* fall back to the string column */
    }
  }
  return resolveSalesOrders(parseLegacySalesOrders(legacy).map((number) => ({ number, stopId: null })), stops);
}

export function salesOrdersForStop(lines: SalesOrderLine[], stopId: string): string[] {
  return lines.filter((line) => line.stopId === stopId).map((line) => line.number);
}

/** Problems that block saving: bad SOs, duplicates, or a missing drop on a multi-drop load. */
export function salesOrderLineErrors(
  lines: Array<{ number: string; stopId?: string | null }>,
  stops: Array<{ id: string; kind: string }>,
  options: { required?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const filled = lines.filter((line) => line.number.trim());
  if (options.required && filled.length === 0) errors.push("Sales order number is required.");
  if (filled.length > SALES_ORDERS_MAX) errors.push(`A load can have at most ${SALES_ORDERS_MAX} sales orders.`);
  const drops = stops.filter((stop) => stop.kind === "drop").map((stop) => stop.id);
  const seen = new Set<string>();
  filled.forEach((line, index) => {
    const label = `Sales order ${index + 1}`;
    const problem = salesOrderError(line.number);
    if (problem) errors.push(`${label}: ${problem}`);
    const number = normalizeSalesOrder(line.number);
    if (seen.has(number)) errors.push(`${label}: ${number} is listed twice.`);
    seen.add(number);
    if (drops.length > 1 && !(line.stopId && drops.includes(line.stopId))) {
      errors.push(`${label}: choose which drop ${number || "it"} goes to.`);
    }
  });
  return errors;
}

/**
 * SQL that finds a load carrying one SO, whether it is the whole value, one line of
 * sales_orders_json, or one part of an older comma-separated string. Use with salesOrderMatchArgs.
 */
export const SALES_ORDER_MATCH_SQL = `(
  UPPER(sales_order_number) = ?
  OR EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(sales_orders_json) THEN sales_orders_json ELSE '[]' END) AS so_line
    WHERE json_extract(so_line.value, '$.number') = ?
  )
  OR (',' || REPLACE(REPLACE(UPPER(sales_order_number), ' ', ''), ';', ',') || ',') LIKE ? ESCAPE '\\'
)`;

export function salesOrderMatchArgs(raw: string): [string, string, string] {
  const value = normalizeSalesOrder(raw);
  const escaped = value.replace(/[\\%_]/g, (char) => `\\${char}`);
  return [value, value, `%,${escaped},%`];
}
