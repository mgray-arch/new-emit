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
  truckType: TruckType | null;
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
  truckType: TruckType | null;
  trackingLink: string | null;
}

/** customer = add loads, no pricing. emit_viewer = view only. emit_admin = full access. admin = Select. */
export type PortalRole = "customer" | "emit_viewer" | "emit_admin" | "admin";

/** The one permission a Select admin assigns. Pricing is included only in full access. */
export type EmitPermission = "view" | "add" | "full";

export const EMIT_PERMISSIONS = ["view", "add", "full"] as const;

export const PERMISSION_LABEL: Record<EmitPermission, string> = {
  view: "View only",
  add: "Add loads",
  full: "Full access",
};

/** Select staff, and EMIT full access, see what Select charges EMIT. Nobody at EMIT sees carrier pay. */
export function canSeePricing(role: string | null | undefined): boolean {
  return role === "admin" || role === "emit_admin";
}

/** View only can look. Add loads and full access can create and edit. Select can too, unless they are viewing as view only. */
export function canAddLoads(role: string | null | undefined): boolean {
  return role === "admin" || role === "emit_admin" || role === "customer";
}

/** Saved delivery locations. Full access and Select. Pickup sites stay with Select. */
export function canManageLocations(role: string | null | undefined): boolean {
  return role === "admin" || role === "emit_admin";
}

export function permissionFromRole(role: string | null | undefined): EmitPermission | null {
  if (role === "emit_viewer") return "view";
  if (role === "customer") return "add";
  if (role === "emit_admin") return "full";
  return null;
}

export function roleFromPermission(permission: EmitPermission): PortalRole {
  if (permission === "view") return "emit_viewer";
  if (permission === "full") return "emit_admin";
  return "customer";
}

export interface Session {
  userId: string;
  email: string;
  name: string;
  role: PortalRole;
  /** Bumped when the password changes so older cookies stop working. */
  passwordEpoch?: number;
  /** The signed-in role. Equals role unless Select is previewing an EMIT role. */
  actorRole?: PortalRole;
  /** Set only for a Select admin who is previewing an EMIT role. */
  viewAs?: PortalRole | null;
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
