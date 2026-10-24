import { z } from "zod";
import { HH_MM } from "@/lib/ship-time";
import { PORTAL_STATUSES, RATE_REASONS, TRANSIT_OPTIONS, TRUCK_TYPES } from "@/lib/types";

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date").nullable().optional();

export const placeSchema = z.object({
  company: z.string().trim().min(1, "Company is required").max(120),
  address1: z.string().trim().min(1, "Address is required").max(200),
  address2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1, "City is required").max(80),
  state: z
    .string()
    .trim()
    .min(2)
    .max(2)
    .transform((value) => value.toUpperCase()),
  postalCode: z.string().trim().max(12).optional().default(""),
  country: z.string().trim().max(2).optional().default("US"),
});

export const stopSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(["pickup", "drop"]),
  place: placeSchema,
  locationId: z.string().trim().max(80).nullable().optional(),
  saveAsNew: z.boolean().optional(),
  contact: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(500).optional(),
});

const orderFields = {
  salesOrderNumber: z.string().trim().min(1, "Sales order number is required").max(80),
  origin: placeSchema.optional(),
  destination: placeSchema.optional(),
  stops: z.array(stopSchema).max(25).optional(),
  portalStatus: z.enum(PORTAL_STATUSES).optional(),
  truckType: z.enum(TRUCK_TYPES).nullable().optional(),
  transit: z.enum(TRANSIT_OPTIONS).nullable().optional(),
  shipDate: dateField,
  shipTime: z.string().regex(HH_MM, "Use HH:MM").nullable().optional(),
  mustDeliverDate: dateField,
  truckEta: dateField,
  customerCost: z.number().min(0).max(1_000_000).nullable().optional(),
  rateReason: z.enum(RATE_REASONS).nullable().optional(),
  comments: z.string().max(2000).optional(),
};

function requireRoute(value: { origin?: unknown; destination?: unknown; stops?: Array<{ kind: string }> }, ctx: z.RefinementCtx, mode: "create" | "patch") {
  if (value.stops && value.stops.length > 0) {
    if (!value.stops.some((stop) => stop.kind === "pickup")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Add at least one pickup.", path: ["stops"] });
    }
    if (!value.stops.some((stop) => stop.kind === "drop")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Add at least one drop.", path: ["stops"] });
    }
    return;
  }
  if (mode === "patch") return;
  if (!value.origin) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Origin is required.", path: ["origin"] });
  if (!value.destination) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Destination is required.", path: ["destination"] });
}

export const orderInputSchema = z.object(orderFields).superRefine((value, ctx) => requireRoute(value, ctx, "create"));

export const orderPatchSchema = z
  .object({ ...orderFields, salesOrderNumber: orderFields.salesOrderNumber.optional() })
  .partial()
  .superRefine((value, ctx) => requireRoute(value, ctx, "patch"));

export const siteSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  company: z.string().trim().min(1).max(120),
  address1: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(80),
  state: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  postalCode: z.string().trim().max(12).optional().default(""),
  country: z.string().trim().max(2).optional().default("US"),
  active: z.boolean().optional().default(true),
});

export const sitesSchema = z.object({
  sites: z.array(siteSchema).min(1),
});

const contactEmail = z.string().trim().email("Enter a contact email").max(200).transform((value) => value.toLowerCase());

export const receiverCreateSchema = z.object({
  company: z.string().trim().min(2).max(160),
  contactEmails: z.array(contactEmail).max(30).default([]),
});

export const receiverPatchSchema = z.object({
  company: z.string().trim().min(2).max(160).optional(),
  contactEmails: z.array(contactEmail).max(30).optional(),
  enabled: z.boolean().optional(),
});

export const locationPatchSchema = z.object({
  company: z.string().trim().min(1).max(120),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(120).optional().default(""),
  city: z.string().trim().min(1).max(80),
  state: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  postalCode: z.string().trim().max(12).optional().default(""),
  country: z.string().trim().max(2).optional().default("US"),
  contact: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(40).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),
  receiverId: z.string().trim().max(80).nullable().optional(),
  active: z.boolean().optional(),
});

export type OrderInput = z.infer<typeof orderInputSchema>;
export type OrderPatch = z.infer<typeof orderPatchSchema>;
