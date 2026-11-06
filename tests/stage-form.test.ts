import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyDraft } from "@/components/load-form";
import { stageBecomesReadyToShip } from "@/lib/load-stage";

describe("stage on the load form", () => {
  it("starts a new load at Being Prepared and asks before Ready to Ship", () => {
    expect(emptyDraft().portalStatus).toBe("being_prepared");
    expect(stageBecomesReadyToShip(null, "being_prepared")).toBe(false);
    expect(stageBecomesReadyToShip("being_prepared", "ready_to_ship")).toBe(true);
    expect(stageBecomesReadyToShip("ready_to_ship", "ready_to_ship")).toBe(false);
    expect(stageBecomesReadyToShip("ready_to_ship", "shipped")).toBe(false);

    const form = readFileSync("components/load-form.tsx", "utf8");
    const dashboard = readFileSync("components/dashboard.tsx", "utf8");
    const orderPage = readFileSync("app/orders/[id]/page.tsx", "utf8");
    expect(form).toContain('aria-label="Stage"');
    expect(form).toContain("Being Prepared");
    expect(dashboard).toContain("Save as Ready to Ship");
    expect(dashboard).not.toContain("posts this order to Slack once");
    expect(dashboard).not.toContain("Load Builder uses that post");
    expect(orderPage).not.toContain("window.print");
    expect(orderPage).not.toContain("changeStage");
    expect(orderPage).toContain("BOL not uploaded yet");
    expect(orderPage).toContain("/bol/print");
    expect(orderPage).toContain("Track shipment");
    expect(orderPage).toContain("TrackingCallout");
  });
});
