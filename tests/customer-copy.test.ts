import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BuildStatus from "@/components/build-status";
import SelectLoadField from "@/components/select-load-field";
import Timeline from "@/components/timeline";
import { customerBuildStatus, customerFacingText, trackingCardCopy } from "@/lib/customer-copy";
import { presentCustomerOrder, toPublicTracking } from "@/lib/customer-view";
import type { CustomerOrder } from "@/lib/types";

const SAM_WORD = /\bSAM\b/i;
const noop = () => {};

function order(patch: Partial<CustomerOrder> = {}): CustomerOrder {
  const place = {
    company: "EMIT",
    address1: "1 Main",
    city: "Sheridan",
    state: "WY",
    postalCode: "82801",
    country: "US",
  };
  const drop = { ...place, company: "Dock", city: "Houston", state: "TX", postalCode: "77002" };
  return {
    id: "order-1",
    salesOrderNumber: "SO123454TEST",
    salesOrders: [],
    loadNumber: "467624-1",
    portalStatus: "ready_to_ship",
    trackingStage: "booked",
    timeline: [
      { stage: "submitted", at: "2026-11-01T12:00:00.000Z", label: "Confirmed" },
      { stage: "booked", at: "2026-11-02T12:00:00.000Z", label: "Booked" },
    ],
    origin: place,
    destination: drop,
    stops: [
      { id: "s1", kind: "pickup", place },
      { id: "s2", kind: "drop", place: drop },
    ],
    truckType: "Flatbed",
    transit: "Normal",
    shipDate: "2026-11-24",
    shipTime: null,
    mustDeliverDate: null,
    truckEta: null,
    latestEta: null,
    trackingUrl: "http://portal.test/track/abc",
    trackingLink: null,
    comments: "Waiting for Select to build this in SAM.",
    createdBy: "Imported from SAM",
    enteredByName: "Imported from SAM",
    enteredByEmail: "imports@select.example",
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-02T12:00:00.000Z",
    attachmentCount: 0,
    bolCount: 1,
    documents: [],
    carrierName: "TETON TRUCKS INC",
    carrierMc: "1600217",
    slackNotifiedAt: "2026-11-01T12:00:00.000Z",
    notices: [
      {
        at: "2026-11-02T12:00:00.000Z",
        kind: "assigned",
        text: "Carrier assigned: TETON TRUCKS INC. MC 1600217.",
        company: "TETON TRUCKS INC",
        mc: "1600217",
      },
    ],
    ...patch,
  };
}

describe("customer copy has no SAM", () => {
  it("serializes EMIT, sales, loader, public, and view-as payloads without the word SAM", () => {
    const viewers = [
      "customer",
      "emit_viewer",
      "emit_admin",
      { role: "customer" as const, profile: "sales" as const },
      { role: "customer" as const, profile: "loader" as const },
      { role: "admin" as const, viewAs: { access: "regular" as const, permission: "view" as const } },
      { role: "admin" as const, viewAs: { access: "admin" as const, permission: "full" as const, profile: "sales" as const } },
    ];
    for (const viewer of viewers) {
      const view = presentCustomerOrder(order(), viewer);
      expect(JSON.stringify(view), JSON.stringify(viewer)).not.toMatch(SAM_WORD);
      expect(view.buildStatus).toBe("Load # 467624-1");
      expect(view.enteredByName).toBe("Imported");
      expect(view.createdBy).toBe("Imported");
      expect(view.loadNumber).toBe("467624-1");
      expect(view.trackingStage).toBe("booked");
      expect(view.carrierName).toBe("TETON TRUCKS INC");
    }
    const pub = toPublicTracking(order({ salesOrderNumber: "SO123454TEST", origin: { ...order().origin, city: "Sheridan" } }));
    expect(JSON.stringify(pub)).not.toMatch(SAM_WORD);
    expect(customerFacingText("Imported from SAM")).toBe("Imported");
    expect(customerFacingText("Built in SAM: 467624-1")).toBe("Load # 467624-1");
    expect(customerBuildStatus("467624-1", "2026-11-01T12:00:00.000Z")).toBe("Load # 467624-1");
    expect(customerBuildStatus(null, "2026-11-01T12:00:00.000Z")).toBe("Sent to Slack");

    const select = presentCustomerOrder(order(), "admin");
    expect(select.buildStatus).toBe("Built in SAM: 467624-1");
  });

  it("follows Booked on the customer tracking card when a carrier is assigned and tracking is not live yet", () => {
    expect(trackingCardCopy({ trackingStage: "submitted", carrierAssigned: false }).phrase).toBe(
      "Confirmed - waiting for carrier",
    );
    expect(trackingCardCopy({ trackingStage: "booked", carrierAssigned: true }).phrase).toBe("Booked - carrier assigned");
    expect(trackingCardCopy({ trackingStage: "booked", carrierAssigned: false }).title).toBe("Being scheduled");
    expect(trackingCardCopy({ trackingStage: "in_transit", carrierAssigned: true }).kicker).toBe("Picked up");
    expect(trackingCardCopy({ trackingStage: "delivered", carrierAssigned: true }).phrase).toBe("Delivered");

    const booked = renderToStaticMarkup(
      createElement(SelectLoadField, {
        orderId: "order-1",
        loadNumber: "467624-1",
        canCorrect: false,
        trackingStage: "booked",
        carrierAssigned: true,
        trackingLink: null,
        onUpdated: noop,
      }),
    );
    expect(booked).toContain('aria-label="Booked - carrier assigned"');
    expect(booked).toContain("Booked");
    expect(booked).toContain("Carrier assigned");
    expect(booked).toContain("No live tracking link yet. Select adds one when the truck is on the way.");
    expect(booked).not.toMatch(SAM_WORD);
    expect(booked).not.toContain("Pending");
    expect(booked).not.toContain("Waiting for SAM");

    const confirmed = renderToStaticMarkup(
      createElement(SelectLoadField, {
        orderId: "order-1",
        loadNumber: null,
        canCorrect: false,
        trackingStage: "submitted",
        carrierAssigned: false,
        onUpdated: noop,
      }),
    );
    expect(confirmed).toContain("Waiting for carrier");
    expect(confirmed).toContain("Confirmed");
    expect(confirmed).not.toMatch(SAM_WORD);

    const progress = renderToStaticMarkup(
      createElement(Timeline, { order: { trackingStage: "booked", portalStatus: "ready_to_ship" } }),
    );
    expect(progress).toContain("Booked");
    expect(progress).toContain("A truck is booked");
    expect(progress).not.toMatch(SAM_WORD);

    const status = renderToStaticMarkup(createElement(BuildStatus, { status: "Load # 467624-1" }));
    expect(status).toContain("Load # 467624-1");
    expect(status).not.toMatch(SAM_WORD);

    for (const file of ["app/orders/[id]/page.tsx", "components/dashboard.tsx", "components/shell.tsx", "components/photo-gallery.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(SAM_WORD);
    }
  });
});
