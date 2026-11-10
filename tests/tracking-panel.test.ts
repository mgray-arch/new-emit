import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SelectLoadField from "@/components/select-load-field";
import TrackingLinkField from "@/components/tracking-link-field";

const noop = () => {};

describe("tracking panel", () => {
  it("shows a stored SAM number as status, and pending when it is missing", () => {
    const built = renderToStaticMarkup(
      createElement(SelectLoadField, { orderId: "o1", loadNumber: "466318-1", canCorrect: true, onUpdated: noop }),
    );
    expect(built).toContain("Built in SAM");
    expect(built).toContain("466318-1");
    expect(built).toContain("Correct");
    expect(built).not.toContain("<input");
    expect(built).not.toContain("Save load number");
    expect(built).not.toContain("Enter the load number from SAM");

    const pending = renderToStaticMarkup(
      createElement(SelectLoadField, { orderId: "o1", loadNumber: null, canCorrect: true, onUpdated: noop }),
    );
    expect(pending).toContain("Waiting for SAM build");
    expect(pending).toContain("Pending");
    expect(pending).not.toContain("<input");
    expect(pending).not.toContain("Save load number");

    const emit = renderToStaticMarkup(
      createElement(SelectLoadField, {
        orderId: "o1",
        loadNumber: "467624-1",
        canCorrect: false,
        trackingStage: "booked",
        carrierAssigned: true,
        trackingLink: null,
        onUpdated: noop,
      }),
    );
    expect(emit).toContain("Booked - carrier assigned");
    expect(emit).toContain("No live tracking link yet");
    expect(emit).not.toMatch(/\bSAM\b/i);
    expect(emit).not.toContain("Correct");
    expect(emit).not.toContain("<input");
    expect(emit).not.toContain("Save");
  });

  it("keeps the tracking link empty state, and hides the save form until Select adds one", () => {
    const empty = renderToStaticMarkup(
      createElement(TrackingLinkField, { orderId: "o1", trackingLink: null, onUpdated: noop }),
    );
    expect(empty).toContain("No live tracking link yet");
    expect(empty).toContain("Add tracking link");
    expect(empty).not.toContain("<input");
    expect(empty).not.toContain("Save tracking link");

    const linked = renderToStaticMarkup(
      createElement(TrackingLinkField, {
        orderId: "o1",
        trackingLink: "https://customer.goselect.com/tracking/abc",
        onUpdated: noop,
      }),
    );
    expect(linked).toContain("https://customer.goselect.com/tracking/abc");
    expect(linked).toContain("Change");
    expect(linked).not.toContain("<input");
    expect(linked).not.toContain("Save tracking link");
  });

  it("does not tell anyone to type the SAM number, and EMIT cannot correct it", () => {
    const page = readFileSync("app/orders/[id]/page.tsx", "utf8");
    const field = readFileSync("components/select-load-field.tsx", "utf8");
    expect(page).toContain("canCorrect={canUpload}");
    expect(page).not.toContain("Enter the load number from SAM");
    expect(field).not.toContain("Enter the load number from SAM");
    expect(field).not.toContain("Save load number");
  });
});
