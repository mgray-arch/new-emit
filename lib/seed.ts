import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { addDaysISO, denverDate, denverLocalToISO } from "@/lib/dates";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { ingestDocument } from "@/lib/documents";
import { ingestCarrierPhoto, solidPng } from "@/lib/photos";
import { demoTrackingToken, timelineThrough } from "@/lib/orders";
import type { Place, PortalStatus, RateReason, TrackingStage, TransitOption, TruckType } from "@/lib/types";

/** Fake carrier-pay values planted in the internal columns. They must never reach EMIT. */
export const DEMO_CARRIER_PAY_CENTS = 876543;
export const DEMO_CARRIER_NAME = "BLACKHAWK HAULING LLC";
export const DEMO_CARRIER_MC = "998877";
export const DEMO_STAFF_NOTE =
  "INTERNAL-ONLY-SENTINEL carrier pay is $8,765.43 for BLACKHAWK HAULING LLC MC 998877";

const allen: Place = {
  company: "EMIT Technologies",
  address1: "2437 Allen Avenue",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  country: "US",
};
const north: Place = {
  company: "EMIT Technologies",
  address1: "2571 North Main Street",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  country: "US",
};
const pen: Place = {
  company: "EMIT Technologies - PEN",
  address1: "102 Ford Cove Drive",
  city: "Catersburg",
  state: "PA",
  postalCode: "15317",
  country: "US",
};
const vectis: Place = {
  company: "Vectis Automation",
  address1: "451 St Cloud Dr",
  city: "Loveland",
  state: "CO",
  postalCode: "80538",
  country: "US",
};
const encore: Place = {
  company: "Encore Oilfield Services LLC",
  address1: "3606 Encore Ave",
  city: "Millsap",
  state: "TX",
  postalCode: "76066",
  country: "US",
};
const kodiak: Place = {
  company: "Kodiak Gas Services",
  address1: "6801 Brooklyn Court",
  city: "Oklahoma City",
  state: "OK",
  postalCode: "73132",
  country: "US",
};
const johnson: Place = {
  company: "Johnson Thermal Systems LLC",
  address1: "1665 Sheed Parkway",
  city: "Caldwell",
  state: "ID",
  postalCode: "83605",
  country: "US",
};
const enchanted: Place = {
  company: "Enchanted Rock LLC",
  address1: "1850 Mound Road",
  city: "Cypress",
  state: "TX",
  postalCode: "77433",
  country: "US",
};
const spitzer: Place = {
  company: "Spitzer Industries, Inc.",
  address1: "10443 Fisher Road",
  city: "Houston",
  state: "TX",
  postalCode: "77041",
  country: "US",
};

interface SeedLoad {
  salesOrderNumber: string;
  loadNumber: string;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  origin: Place;
  destination: Place;
  truckType: TruckType;
  transit: TransitOption;
  shipOffset: number;
  shipTime: string;
  deliverOffset: number;
  etaOffset: number | null;
  customerCost: number | null;
  rateReason: RateReason | null;
  comments: string;
  createdBy: string;
}

const LOADS: SeedLoad[] = [
  {
    salesOrderNumber: "SO2196",
    loadNumber: "900196-1",
    portalStatus: "shipped",
    trackingStage: "in_transit",
    origin: allen,
    destination: kodiak,
    truckType: "Hot Shot",
    transit: "Normal",
    shipOffset: 0,
    shipTime: "14:30",
    deliverOffset: 2,
    etaOffset: 1,
    customerCost: 1500,
    rateReason: null,
    comments: "Call the Sheridan shipping office before the driver arrives.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO2981",
    loadNumber: "900181-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    origin: allen,
    destination: encore,
    truckType: "Hot Shot",
    transit: "Normal",
    shipOffset: 0,
    shipTime: "16:00",
    deliverOffset: 1,
    etaOffset: 1,
    customerCost: 1680,
    rateReason: "Last Minute",
    comments: "Ready on the Allen Ave dock.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO68582 and SO68583",
    loadNumber: "900182-1",
    portalStatus: "shipped",
    trackingStage: "at_pickup",
    origin: allen,
    destination: johnson,
    truckType: "53' Flatbed",
    transit: "Normal",
    shipOffset: 0,
    shipTime: "16:30",
    deliverOffset: 3,
    etaOffset: 3,
    customerCost: 2400,
    rateReason: null,
    comments: "Two skids, tarps required.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "so-003108_T16",
    loadNumber: "900183-1",
    portalStatus: "shipped",
    trackingStage: "in_transit",
    origin: north,
    destination: enchanted,
    truckType: "48' Flatbed",
    transit: "Normal",
    shipOffset: 0,
    shipTime: "09:00",
    deliverOffset: 2,
    etaOffset: 2,
    customerCost: 2100,
    rateReason: null,
    comments: "Enchanted Rock appointment on file.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "so-003108_T15",
    loadNumber: "900184-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    origin: north,
    destination: enchanted,
    truckType: "48' Flatbed",
    transit: "Normal",
    shipOffset: 1,
    shipTime: "10:00",
    deliverOffset: 3,
    etaOffset: null,
    customerCost: 2100,
    rateReason: null,
    comments: "Second truck for the Cypress delivery.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO-002722",
    loadNumber: "900185-1",
    portalStatus: "shipped",
    trackingStage: "delivered",
    origin: allen,
    destination: kodiak,
    truckType: "24' Box Truck",
    transit: "Normal",
    shipOffset: -3,
    shipTime: "08:00",
    deliverOffset: -1,
    etaOffset: -1,
    customerCost: 980,
    rateReason: null,
    comments: "Delivered. POD is with the paperwork.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "Machines pick up",
    loadNumber: "900186-1",
    portalStatus: "being_prepared",
    trackingStage: "submitted",
    origin: vectis,
    destination: north,
    truckType: "24' Box Truck",
    transit: "Normal",
    shipOffset: 2,
    shipTime: "09:00",
    deliverOffset: 3,
    etaOffset: null,
    customerCost: null,
    rateReason: null,
    comments: "Machines pick up at Vectis, deliver to North Main.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "transfer orders wk 42",
    loadNumber: "900187-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    origin: north,
    destination: pen,
    truckType: "24' Box Truck",
    transit: "Normal",
    shipOffset: 3,
    shipTime: "07:00",
    deliverOffset: 6,
    etaOffset: null,
    customerCost: 1750,
    rateReason: "Extra transit days",
    comments: "Internal transfer to the PEN site.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "so-68008, so-67870, so-2482, so-2483",
    loadNumber: "900188-1",
    portalStatus: "shipped",
    trackingStage: "in_transit",
    origin: allen,
    destination: spitzer,
    truckType: "48' Flatbed",
    transit: "Normal",
    shipOffset: -1,
    shipTime: "11:00",
    deliverOffset: 1,
    etaOffset: 1,
    customerCost: 1890,
    rateReason: null,
    comments: "Four sales orders on one flatbed.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO4410",
    loadNumber: "900189-1",
    portalStatus: "cancelled",
    trackingStage: "submitted",
    origin: allen,
    destination: encore,
    truckType: "Flatbed",
    transit: "Normal",
    shipOffset: 1,
    shipTime: "12:00",
    deliverOffset: 3,
    etaOffset: null,
    customerCost: null,
    rateReason: "Weather",
    comments: "Cancelled after the weather hold.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4418",
    loadNumber: "900190-1",
    portalStatus: "shipped",
    trackingStage: "delivered",
    origin: north,
    destination: johnson,
    truckType: "Conestoga",
    transit: "Normal",
    shipOffset: -4,
    shipTime: "06:30",
    deliverOffset: -1,
    etaOffset: -1,
    customerCost: 2600,
    rateReason: null,
    comments: "Delivered to Caldwell earlier this week.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO4422",
    loadNumber: "900191-1",
    portalStatus: "shipped",
    trackingStage: "in_transit",
    origin: allen,
    destination: enchanted,
    truckType: "Hot Shot",
    transit: "Team",
    shipOffset: 0,
    shipTime: "05:00",
    deliverOffset: 2,
    etaOffset: 2,
    customerCost: 3200,
    rateReason: "Team",
    comments: "Team driver requested for the Cypress window.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4429",
    loadNumber: "900192-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    origin: north,
    destination: spitzer,
    truckType: "53' Flatbed",
    transit: "Normal",
    shipOffset: 2,
    shipTime: "13:00",
    deliverOffset: 4,
    etaOffset: null,
    customerCost: 2050,
    rateReason: "Capacity",
    comments: "Sunday delivery into Houston.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4501",
    loadNumber: "900193-1",
    portalStatus: "being_prepared",
    trackingStage: "submitted",
    origin: allen,
    destination: kodiak,
    truckType: "Sprinter Van",
    transit: "Normal",
    shipOffset: 8,
    shipTime: "09:30",
    deliverOffset: 9,
    etaOffset: null,
    customerCost: 640,
    rateReason: null,
    comments: "Small parts, next week.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO4508",
    loadNumber: "900194-1",
    portalStatus: "being_prepared",
    trackingStage: "submitted",
    origin: pen,
    destination: north,
    truckType: "20' Box Truck",
    transit: "Normal",
    shipOffset: 7,
    shipTime: "08:00",
    deliverOffset: 10,
    etaOffset: null,
    customerCost: null,
    rateReason: null,
    comments: "Return freight from PEN.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4514",
    loadNumber: "900195-1",
    portalStatus: "cancelled",
    trackingStage: "booked",
    origin: allen,
    destination: johnson,
    truckType: "Flatbed",
    transit: "Normal",
    shipOffset: -2,
    shipTime: "15:00",
    deliverOffset: 1,
    etaOffset: null,
    customerCost: 1400,
    rateReason: "Other",
    comments: "Order pulled by the plant.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4520",
    loadNumber: "900197-1",
    portalStatus: "shipped",
    trackingStage: "in_transit",
    origin: north,
    destination: spitzer,
    truckType: "LTL",
    transit: "Normal",
    shipOffset: -2,
    shipTime: "16:00",
    deliverOffset: 2,
    etaOffset: 2,
    customerCost: 870,
    rateReason: null,
    comments: "LTL into Houston.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO4526",
    loadNumber: "900198-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    origin: allen,
    destination: encore,
    truckType: "Hot Shot",
    transit: "Team",
    shipOffset: 1,
    shipTime: "18:00",
    deliverOffset: 2,
    etaOffset: null,
    customerCost: 2750,
    rateReason: "Team",
    comments: "After-hours pickup.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4533",
    loadNumber: "900199-1",
    portalStatus: "being_prepared",
    trackingStage: "submitted",
    origin: north,
    destination: kodiak,
    truckType: "Flatbed",
    transit: "Normal",
    shipOffset: 4,
    shipTime: "11:00",
    deliverOffset: 6,
    etaOffset: null,
    customerCost: null,
    rateReason: null,
    comments: "Waiting on the pack list.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4540",
    loadNumber: "900200-1",
    portalStatus: "shipped",
    trackingStage: "delivered",
    origin: allen,
    destination: encore,
    truckType: "48' Flatbed",
    transit: "Normal",
    shipOffset: -10,
    shipTime: "07:30",
    deliverOffset: -8,
    etaOffset: -8,
    customerCost: 1320,
    rateReason: null,
    comments: "Closed last week.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO4547",
    loadNumber: "900201-1",
    portalStatus: "shipped",
    trackingStage: "at_pickup",
    origin: allen,
    destination: johnson,
    truckType: "Conestoga",
    transit: "Normal",
    shipOffset: 0,
    shipTime: "13:00",
    deliverOffset: 3,
    etaOffset: 3,
    customerCost: 2550,
    rateReason: "Lay Over",
    comments: "Driver is checking in at Allen Ave.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4555",
    loadNumber: "900202-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    origin: north,
    destination: enchanted,
    truckType: "Multi Stop Box Truck",
    transit: "Normal",
    shipOffset: 1,
    shipTime: "08:30",
    deliverOffset: 3,
    etaOffset: null,
    customerCost: 1900,
    rateReason: null,
    comments: "Multi-stop box truck for Cypress.",
    createdBy: "J. Hale",
  },
  {
    salesOrderNumber: "SO4562",
    loadNumber: "900203-1",
    portalStatus: "cancelled",
    trackingStage: "submitted",
    origin: pen,
    destination: spitzer,
    truckType: "53' Flatbed",
    transit: "Normal",
    shipOffset: 5,
    shipTime: "10:00",
    deliverOffset: 8,
    etaOffset: null,
    customerCost: null,
    rateReason: "Capacity",
    comments: "Cancelled before tender.",
    createdBy: "M. Gray",
  },
  {
    salesOrderNumber: "SO4570",
    loadNumber: "900204-1",
    portalStatus: "shipped",
    trackingStage: "in_transit",
    origin: allen,
    destination: encore,
    truckType: "20' Box Truck",
    transit: "Normal",
    shipOffset: -1,
    shipTime: "15:00",
    deliverOffset: 1,
    etaOffset: 0,
    customerCost: 1100,
    rateReason: "Detention at shipper",
    comments: "Left yesterday after a short detention.",
    createdBy: "M. Gray",
  },
];

const SITES = [allen, north, pen, vectis];

function stopsForLoad(load: SeedLoad) {
  if (load.salesOrderNumber === "SO4555") {
    return [
      { id: "stop-1", kind: "pickup" as const, place: load.origin },
      { id: "stop-2", kind: "pickup" as const, place: allen },
      { id: "stop-3", kind: "drop" as const, place: load.destination },
    ];
  }
  return [
    { id: "stop-1", kind: "pickup" as const, place: load.origin },
    { id: "stop-2", kind: "drop" as const, place: load.destination },
  ];
}

async function pdfFromLines(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    for (const line of lines) {
      page.drawText(line, { x: 48, y, size: 12, font });
      y -= 18;
    }
  }
  return doc.save();
}

export async function seedDemo(ctx: PortalContext): Promise<void> {
  const password = process.env.DEMO_USER_PASSWORD || "Emit-Demo-2026";
  const hash = bcrypt.hashSync(password, 8);
  const now = ctx.now();
  const today = denverDate(now);
  const createdAt = now.toISOString();

  withTransaction(ctx.db, () => {
    const insertUser = ctx.db.prepare(
      `INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertUser.run(randomUUID(), "m.gray@emit.example", "M. Gray", "customer", hash, createdAt);
    insertUser.run(randomUUID(), "mgray@goselect.com", "Mike Gray", "admin", hash, createdAt);
    insertUser.run(randomUUID(), "dmartin@goselect.com", "Drew Martin", "admin", hash, createdAt);
    insertUser.run(randomUUID(), "ops@enchantedrock.example", "Enchanted Rock", "receiver", hash, createdAt);
    ctx.db
      .prepare(`INSERT INTO receiver_access (id, match_value, company, created_at) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), "enchantedrock.example", "Enchanted Rock LLC", createdAt);

    const insertSite = ctx.db.prepare(
      `INSERT INTO sites (id, company, address1, city, state, postal_code, country, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 'US', 1, ?)`,
    );
    SITES.forEach((site, index) => {
      insertSite.run(randomUUID(), site.company, site.address1, site.city, site.state, site.postalCode, index);
    });

    const insertLoad = ctx.db.prepare(
      `INSERT INTO loads (
         id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
         origin_json, destination_json, stops_json, truck_type, transit, ship_date, ship_time,
         must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
         rate_reason, comments, created_by, created_at, updated_at, pending_review_count,
         carrier_pay_cents, carrier_name, carrier_mc, staff_notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    );

    for (const load of LOADS) {
      const shipDate = addDaysISO(today, load.shipOffset);
      const deliver = addDaysISO(today, load.deliverOffset);
      const latestEta =
        load.etaOffset == null ? null : denverLocalToISO(addDaysISO(today, load.etaOffset), "15:00");
      const anchor = latestEta ?? denverLocalToISO(shipDate, load.shipTime);
      insertLoad.run(
        randomUUID(),
        load.salesOrderNumber,
        load.loadNumber,
        load.portalStatus,
        load.trackingStage,
        JSON.stringify(timelineThrough(load.trackingStage, anchor)),
        JSON.stringify(load.origin),
        JSON.stringify(load.destination),
        JSON.stringify(stopsForLoad(load)),
        load.truckType,
        load.transit,
        shipDate,
        load.shipTime,
        deliver,
        deliver,
        latestEta,
        demoTrackingToken(load.loadNumber),
        load.customerCost == null ? null : Math.round(load.customerCost * 100),
        load.rateReason,
        load.comments,
        load.createdBy,
        createdAt,
        createdAt,
        DEMO_CARRIER_PAY_CENTS,
        DEMO_CARRIER_NAME,
        DEMO_CARRIER_MC,
        DEMO_STAFF_NOTE,
      );
    }
  });

  const so2196 = ctx.db.prepare(`SELECT id FROM loads WHERE sales_order_number = ?`).get("SO2196") as { id: string };
  const so2981 = ctx.db.prepare(`SELECT id FROM loads WHERE sales_order_number = ?`).get("SO2981") as { id: string };
  const so4410 = ctx.db.prepare(`SELECT id FROM loads WHERE sales_order_number = ?`).get("SO4410") as { id: string };

  const bol = await pdfFromLines([
    [
      "BILL OF LADING",
      "Shipper: EMIT Technologies",
      "2437 Allen Avenue, Sheridan, WY",
      "Consignee: Kodiak Gas Services",
      "6801 Brooklyn Court, Oklahoma City, OK",
      "Sales order: SO2196",
      "Commodity: Industrial equipment",
      "Weight: 4200 lbs",
      "Freight terms: Prepaid",
    ],
  ]);
  await ingestDocument(ctx, { loadId: so2196.id, filename: "SO2196-bol.pdf", bytes: bol, slot: "bol" });

  const mixed = await pdfFromLines([
    [
      "BILL OF LADING",
      "Shipper: EMIT Technologies",
      "Consignee: Encore Oilfield Services LLC",
      "Sales order: SO2981",
      "Commodity: Fabricated skid",
      "Weight: 6100 lbs",
      "Freight terms: Prepaid",
    ],
    [
      "RATE CONFIRMATION",
      "Carrier: BLACKHAWK HAULING LLC",
      "MC# 998877",
      "Carrier Pay: $8,765.43",
      "Line Haul: $8,765.43",
      "This page is a carrier rate confirmation and must not be released.",
    ],
  ]);
  await ingestDocument(ctx, { loadId: so2981.id, filename: "SO2981-packet.pdf", bytes: mixed, slot: "bol" });

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await ingestDocument(ctx, { loadId: so4410.id, filename: "scan.png", bytes: new Uint8Array(png), slot: "attachment" });

  const so4555 = ctx.db.prepare(`SELECT load_number FROM loads WHERE sales_order_number = ?`).get("SO4555") as {
    load_number: string;
  };
  ingestCarrierPhoto(ctx, {
    loadNumber: "900196-1",
    filename: "dock.png",
    bytes: solidPng(224, 138, 47),
    source: "gmail",
    receivedAt: "2026-10-14T16:10:00Z",
    subject: "Driver at the Sheridan dock",
  });
  ingestCarrierPhoto(ctx, {
    loadNumber: "900196-1",
    filename: "rate-confirmation.png",
    bytes: solidPng(30, 30, 30, "RATE CONFIRMATION carrier pay $8,765.43"),
    source: "gmail",
    receivedAt: "2026-10-14T16:12:00Z",
    subject: "Rate confirmation for the carrier",
  });
  ingestCarrierPhoto(ctx, {
    loadNumber: so4555.load_number,
    filename: "cypress-arrival.png",
    bytes: solidPng(60, 120, 90),
    source: "gmail",
    receivedAt: "2026-10-14T18:40:00Z",
    subject: "Arrived at Enchanted Rock",
  });
}
