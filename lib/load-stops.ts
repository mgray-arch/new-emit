import {
  parseLegacySalesOrders,
  resolveSalesOrders,
  salesOrdersForStop,
  type SalesOrderLine,
} from "@/lib/sales-orders";
import type { Stop, StopKind, StopSchedule } from "@/lib/types";

/**
 * One stop as Load Builder and the Slack note both see it.
 * Sales orders are listed on drops only, in stored order.
 */
export interface MappedLoadStop {
  sequence: number;
  kind: StopKind;
  salesOrders: string[];
  place: Stop["place"];
  schedule: StopSchedule | null;
}

/**
 * The sales-order lines Load Builder already sends.
 * A stored list is kept. An older single string is split and, when there is one drop, tied to it.
 */
export function salesOrderLinesForLoad(order: {
  salesOrders?: SalesOrderLine[] | null;
  salesOrderNumber: string;
  stops: Array<{ id: string; kind: string }>;
}): SalesOrderLine[] {
  if (order.salesOrders?.length) return order.salesOrders;
  return resolveSalesOrders(
    parseLegacySalesOrders(order.salesOrderNumber).map((number) => ({ number, stopId: null })),
    order.stops,
  );
}

/** Stop list and per-drop sales orders. Slack and loadBuilderPayload both call this. */
export function mappedLoadStops(order: {
  salesOrders?: SalesOrderLine[] | null;
  salesOrderNumber: string;
  stops: Stop[];
}): { lines: SalesOrderLine[]; stops: MappedLoadStop[] } {
  const lines = salesOrderLinesForLoad(order);
  return {
    lines,
    stops: order.stops.map((stop, index) => ({
      sequence: index + 1,
      kind: stop.kind,
      salesOrders: stop.kind === "drop" ? salesOrdersForStop(lines, stop.id) : [],
      place: stop.place,
      schedule: stop.schedule ?? null,
    })),
  };
}
