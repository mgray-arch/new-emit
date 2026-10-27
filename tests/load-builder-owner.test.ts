import { describe, expect, it } from "vitest";
import { DREW_SLACK_USER_ID, loadBuilderOwner, loadBuilderPayload } from "@/lib/load-builder";
import type { CustomerOrder } from "@/lib/types";

function order(overrides: Partial<CustomerOrder>): CustomerOrder {
  return {
    id: "o1",
    salesOrderNumber: "SO-1",
    truckType: "53' Flatbed",
    stops: [
      { kind: "pickup", place: { company: "EMIT", address1: "1 A St", city: "Sheridan", state: "WY", postalCode: "", country: "US" } },
      { kind: "drop", place: { company: "Site", address1: "2 B St", city: "Odessa", state: "TX", postalCode: "", country: "US" } },
    ],
    ...overrides,
  } as unknown as CustomerOrder;
}

describe("Load Builder payload owner", () => {
  it("uses the stored owner and Drew's known Slack id", () => {
    expect(loadBuilderOwner(order({ owner: "Drew" }), {})).toEqual({ name: "Drew", slackUserId: DREW_SLACK_USER_ID });
    expect(DREW_SLACK_USER_ID).toBe("U0AGS6MDBL1");
  });

  it("prefers the env Slack id when set", () => {
    expect(loadBuilderOwner(order({ owner: "Drew" }), { SLACK_USER_ID_DREW: "U999" }).slackUserId).toBe("U999");
  });

  it("gives Ainsley her env id, or just her name when unset", () => {
    expect(loadBuilderOwner(order({ owner: "Ainsley" }), {})).toEqual({ name: "Ainsley", slackUserId: null });
    expect(loadBuilderOwner(order({ owner: "Ainsley" }), { SLACK_USER_ID_AINSLEY: "U0AINSLEY1" }).slackUserId).toBe("U0AINSLEY1");
  });

  it("falls back to the portal owner rule when no owner is stored", () => {
    expect(loadBuilderOwner(order({ owner: null }), {}).name).toBe("Drew");
    expect(loadBuilderOwner(order({ owner: null, truckType: "Box truck" }), {}).name).toBe("Ainsley");
  });

  it("puts owner in the payload and still never carrier pay", () => {
    const payload = loadBuilderPayload({ ...order({ owner: "Ainsley" }), carrierPay: 8765.43 } as CustomerOrder);
    expect(payload.owner).toMatchObject({ name: "Ainsley" });
    expect(JSON.stringify(payload)).not.toMatch(/carrierPay|8765/);
  });
});
