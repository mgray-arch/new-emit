import { z } from "zod";
import { PORTAL_STATUSES, RATE_REASONS, TRANSIT_OPTIONS, TRUCK_TYPES } from "@/lib/types";

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date").nullable().optional();

export const placeSchema = z.object({
  company: z.string().trim().min(1, "Company is required").max(120),
  address1: z.string().trim().min(1, "Address is required").max(200),
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

export const orderInputSchema = z.object({
  salesOrderNumber: z.string().trim().min(1, "Sales order number is required").max(80),
  origin: placeSchema,
  destination: placeSchema,
  portalStatus: z.enum(PORTAL_STATUSES).optional(),
  truckType: z.enum(TRUCK_TYPES).nullable().optional(),
  transit: z.enum(TRANSIT_OPTIONS).nullable().optional(),
  shipDate: dateField,
  shipTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:MM")
    .nullable()
    .optional(),
  mustDeliverDate: dateField,
  truckEta: dateField,
  customerCost: z.number().min(0).max(1_000_000).nullable().optional(),
  rateReason: z.enum(RATE_REASONS).nullable().optional(),
  comments: z.string().max(2000).optional(),
});

export const orderPatchSchema = orderInputSchema.partial();

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

export type OrderInput = z.infer<typeof orderInputSchema>;
export type OrderPatch = z.infer<typeof orderPatchSchema>;
