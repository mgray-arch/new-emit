export const PORTAL_STATUSES = ["being_prepared", "ready_to_ship", "shipped", "cancelled"] as const;
export type PortalStatus = (typeof PORTAL_STATUSES)[number];

export const TRACKING_STAGES = ["submitted", "booked", "at_pickup", "in_transit", "delivered"] as const;
export type TrackingStage = (typeof TRACKING_STAGES)[number];

export const TRUCK_TYPES = [
  "Flatbed",
  "48' Flatbed",
  "53' Flatbed",
  "Conestoga",
  "Hot Shot",
  "Sprinter Van",
  "20' Box Truck",
  "24' Box Truck",
  "Multi Stop Box Truck",
  "LTL",
] as const;
export type TruckType = (typeof TRUCK_TYPES)[number];

/** Per-stop schedule copied from SAM. Dates are calendar dates. Appointment times are local wall-clock HH:MM. */
export interface StopSchedule {
  date: string | null;
  appointmentStart: string | null;
  appointmentEnd: string | null;
  /** Kept only when the appointment text is not a clock time. */
  appointmentText: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
}

export const TRANSIT_OPTIONS = ["Normal", "Team"] as const;
export type TransitOption = (typeof TRANSIT_OPTIONS)[number];

export const RATE_REASONS = [
  "Weather",
  "Last Minute",
  "Extra transit days",
  "Lay Over",
  "Detention at shipper",
  "Detention at receiver",
  "Team",
  "Capacity",
  "Other",
] as const;
export type RateReason = (typeof RATE_REASONS)[number];

export const STATUS_LABEL: Record<PortalStatus, string> = {
  being_prepared: "Being Prepared",
  ready_to_ship: "Ready to Ship",
  shipped: "Shipped",
  cancelled: "Cancelled",
};

export const STAGE_LABEL: Record<TrackingStage, string> = {
  submitted: "Submitted",
  booked: "Booked",
  at_pickup: "At Pickup",
  in_transit: "In Transit",
  delivered: "Delivered",
};

export interface Place {
  company: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export type StopKind = "pickup" | "drop";

/** One pickup or drop. Sequence is the array order on the load. */
export interface Stop {
  id: string;
  kind: StopKind;
  place: Place;
  /** Saved drop this stop was filled from. Empty for a one-off pickup. */
  locationId?: string | null;
  /** Present on historical SAM imports. Portal-entered loads omit it. */
  schedule?: StopSchedule | null;
}

/** Public tracking lists the sequence without street addresses. */
export interface PublicStop {
  kind: StopKind;
  city: string;
  state: string;
}

export interface TimelineEvent {
  stage: TrackingStage;
  at: string;
  label: string;
}

export interface CustomerDocument {
  id: string;
  kind: "attachment" | "bol";
  filename: string;
  mediaType: string;
  createdAt: string;
}

/** Customer-facing shipment. Carrier pay, carrier identity, and margin are not fields on this type. */
export interface CustomerOrder {
  id: string;
  salesOrderNumber: string;
  /** Real Select (SAM) load number, or null until a Select admin or a future SAM sync enters it. */
  loadNumber: string | null;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  timeline: TimelineEvent[];
  origin: Place;
  destination: Place;
  stops: Stop[];
  /** A portal truck type, or the raw equipment text when SAM used a type this list does not have. */
  truckType: string | null;
  transit: TransitOption | null;
  shipDate: string | null;
  shipTime: string | null;
  mustDeliverDate: string | null;
  truckEta: string | null;
  latestEta: string | null;
  /** Portal status page. This is not the carrier's public share link. */
  trackingUrl: string;
  /** SAM / MacroPoint public share link. Null until a Select admin or a future SAM sync sets it. */
  trackingLink: string | null;
  /** EMIT's own cost. Omitted entirely for regular EMIT users. */
  customerCost?: number | null;
  /** Omitted entirely for regular EMIT users. */
  rateReason?: RateReason | null;
  comments: string;
  createdBy: string;
  /** Who submitted the load. Null on older loads. Name and email only. */
  enteredByName?: string | null;
  /** Who submitted the load. Null on older loads. Name and email only. */
  enteredByEmail?: string | null;
  /** Select only. Drew or Ainsley. Omitted for every EMIT user and for view-as. Null on older loads. */
  owner?: "Drew" | "Ainsley" | null;
  /** Select only. True when the auto-assign had no equipment or destination. */
  ownerNeedsCheck?: boolean;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
  bolCount: number;
  /** Pages held for Select. Omitted for every EMIT user, including EMIT admins. */
  pendingReviewCount?: number;
  documents: CustomerDocument[];
  /** Select only. Omitted for every EMIT role and for view-as. */
  samBuildStatus?: "building" | "failed" | null;
  samBuildError?: string | null;
  /** Select only. When the build was requested, so a stuck build can be retried. */
  samBuildAt?: string | null;
  /** Select only. Present when SAM_LOAD_URL_TEMPLATE can build a link. */
  samUrl?: string | null;
}

export interface PublicTracking {
  loadNumber: string | null;
  salesOrderNumber: string;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  timeline: TimelineEvent[];
  latestEta: string | null;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  stops: PublicStop[];
  shipDate: string | null;
  mustDeliverDate: string | null;
  truckType: string | null;
  trackingLink: string | null;
}

/**
 * customer = regular EMIT user. emit_viewer = older view-only rows, treated as regular.
 * emit_admin = EMIT admin. admin = Select. Permission is stored separately.
 */
export type PortalRole = "customer" | "emit_viewer" | "emit_admin" | "admin";

/** What this EMIT person may do with loads and with EMIT's own price. Never carrier pay. */
export type EmitPermission = "view" | "add" | "pricing" | "full";

export type EmitAccess = "admin" | "regular";

export const EMIT_PERMISSIONS = ["view", "add", "pricing", "full"] as const;

export const PERMISSION_LABEL: Record<EmitPermission, string> = {
  view: "View only",
  add: "Add loads",
  pricing: "See pricing",
  full: "Full access",
};

/** Select is previewing one EMIT access plus one permission. The preview cannot write. */
export interface ViewAsPreview {
  access: EmitAccess;
  permission: EmitPermission;
}

export type Viewer =
  | string
  | {
      role?: string | null;
      permission?: EmitPermission | null;
      viewAs?: ViewAsPreview | null;
    }
  | null
  | undefined;

export interface ResolvedAccess {
  role: string;
  permission: EmitPermission | null;
  /** Real Select session, not a view-as preview. */
  select: boolean;
  viewAs: ViewAsPreview | null;
}

export function isEmitPermission(value: string | null | undefined): value is EmitPermission {
  return value === "view" || value === "add" || value === "pricing" || value === "full";
}

/** Effective rules for a session, a legacy role string, or a Select view-as preview. */
export function resolveAccess(viewer: Viewer): ResolvedAccess {
  if (viewer && typeof viewer === "object" && viewer.viewAs) {
    return {
      role: viewer.viewAs.access === "admin" ? "emit_admin" : "customer",
      permission: viewer.viewAs.permission,
      select: false,
      viewAs: viewer.viewAs,
    };
  }
  const role = typeof viewer === "string" ? viewer : (viewer?.role ?? "");
  if (role === "admin") return { role: "admin", permission: null, select: true, viewAs: null };
  if (!role) return { role: "", permission: null, select: false, viewAs: null };
  const explicit = viewer && typeof viewer === "object" ? viewer.permission : undefined;
  const permission = isEmitPermission(explicit) ? explicit : permissionFromRole(role);
  return { role, permission, select: false, viewAs: null };
}

/**
 * Customer price only: what EMIT pays Select. Carrier pay is never included.
 * A regular EMIT user never sees it, including see pricing, full access, and
 * the Select "view as regular user" preview. An EMIT admin sees it with see
 * pricing or full access. Select staff always see it.
 */
export function canSeePricing(viewer: Viewer): boolean {
  const access = resolveAccess(viewer);
  if (access.select) return true;
  if (access.role !== "emit_admin") return false;
  return access.permission === "pricing" || access.permission === "full";
}

/** View only and see pricing can look. Add loads and full access can create and edit. */
export function canAddLoads(viewer: Viewer): boolean {
  const access = resolveAccess(viewer);
  if (access.select) return true;
  return access.permission === "add" || access.permission === "full";
}

/**
 * Saved delivery locations. EMIT admins can manage them unless they are view only.
 * See pricing does not by itself grant this. Pickup sites stay with Select.
 * View-as still reports the capability so the preview matches the role; writes are rejected separately.
 */
export function canManageLocations(viewer: Viewer): boolean {
  const access = resolveAccess(viewer);
  if (access.select) return true;
  return access.role === "emit_admin" && access.permission !== "view";
}

export function permissionFromRole(role: string | null | undefined): EmitPermission | null {
  if (role === "emit_viewer") return "view";
  if (role === "customer") return "add";
  if (role === "emit_admin") return "full";
  return null;
}

/** Legacy mapping when a caller sends only a permission. Full access stays an EMIT admin. */
export function roleFromPermission(permission: EmitPermission): PortalRole {
  if (permission === "full") return "emit_admin";
  return "customer";
}

export function accessFromRole(role: string | null | undefined): EmitAccess {
  return role === "emit_admin" ? "admin" : "regular";
}

export interface Session {
  userId: string;
  email: string;
  name: string;
  role: PortalRole;
  /** Bumped when the password changes so older cookies stop working. */
  passwordEpoch?: number;
  /** EMIT permission from the user row. Null for Select. Ignored while viewAs is set. */
  permission?: EmitPermission | null;
  /** The signed-in role. Equals role unless Select is previewing an EMIT role. */
  actorRole?: PortalRole;
  /** Set only for a Select admin who is previewing an EMIT role. The preview is read-only. */
  viewAs?: ViewAsPreview | null;
}

export interface AssistantReference {
  salesOrderNumber: string;
  loadNumber: string | null;
  trackingUrl: string;
  trackingStage: TrackingStage;
  latestEta: string | null;
  portalStatus: PortalStatus;
  originCity: string;
  destinationCity: string;
}

export interface AssistantAnswer {
  text: string;
  references: AssistantReference[];
  refused: boolean;
}

export interface Site {
  id: string;
  company: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  active: boolean;
  sortOrder: number;
}

export interface ReviewItem {
  id: string;
  loadId: string;
  salesOrderNumber: string;
  loadNumber: string | null;
  /** document = a PDF page or upload. photo = a carrier photo held before EMIT can see it. */
  source: "document" | "photo";
  kind: string;
  screenResult: "block" | "uncertain";
  screenReason: string;
  reviewStatus: "pending" | "approved" | "rejected";
  filename: string;
  mediaType: string;
  pageIndex: number;
  pageCount: number;
  textExcerpt: string | null;
  createdAt: string;
}

/** The number EMIT should see. Pending means Select has not entered the SAM load number yet. */
export function formatLoadNumber(loadNumber: string | null | undefined): string {
  const value = loadNumber?.trim();
  return value ? value : "Pending";
}

export function formatPlace(place: Place): string {
  const cityLine = [place.city, place.state].filter(Boolean).join(", ");
  return [place.company, place.address1, place.address2, cityLine, place.postalCode].filter(Boolean).join(", ");
}

export function mapsUrl(place: Place): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatPlace(place))}`;
}
