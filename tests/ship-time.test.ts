import { describe, expect, it } from "vitest";
import { emptyDraft, payloadFromDraft } from "@/components/load-form";
import { HALF_HOUR_TIMES, timeSelectOptions } from "@/lib/ship-time";
import { orderInputSchema } from "@/lib/validate";

const place = (company: string, city: string, state: string) => ({
  company,
  address1: "1 Main",
  city,
  state,
  postalCode: "00000",
  country: "US",
});

function parseTime(shipTime: unknown) {
  return orderInputSchema.safeParse({
    salesOrderNumber: "SO-TIME",
    shipTime,
    stops: [
      { kind: "pickup", place: place("EMIT", "Sheridan", "WY") },
      { kind: "drop", place: place("Kodiak", "Oklahoma City", "OK") },
    ],
  });
}

describe("half-hour ship times", () => {
  it("offers 00:00 through 23:30 in 24-hour steps of 30 minutes", () => {
    expect(HALF_HOUR_TIMES).toHaveLength(48);
    expect(HALF_HOUR_TIMES[0]).toBe("00:00");
    expect(HALF_HOUR_TIMES[1]).toBe("00:30");
    expect(HALF_HOUR_TIMES[2]).toBe("01:00");
    expect(HALF_HOUR_TIMES.at(-1)).toBe("23:30");
    expect(HALF_HOUR_TIMES.some((time) => /am|pm/i.test(time))).toBe(false);
    expect(new Set(HALF_HOUR_TIMES).size).toBe(48);
    for (let index = 1; index < HALF_HOUR_TIMES.length; index += 1) {
      const [prevHour, prevMinute] = HALF_HOUR_TIMES[index - 1].split(":").map(Number);
      const [hour, minute] = HALF_HOUR_TIMES[index].split(":").map(Number);
      const delta = hour * 60 + minute - (prevHour * 60 + prevMinute);
      expect(delta).toBe(30);
    }
  });

  it("keeps a previously saved minute without duplicating a half hour", () => {
    expect(timeSelectOptions("")).toEqual(HALF_HOUR_TIMES);
    expect(timeSelectOptions("   ")).toEqual(HALF_HOUR_TIMES);
    expect(timeSelectOptions("14:30")).toEqual(HALF_HOUR_TIMES);
    expect(timeSelectOptions("2:30 PM")).toEqual(HALF_HOUR_TIMES);

    const withLegacy = timeSelectOptions("09:52");
    expect(withLegacy).toHaveLength(49);
    expect(withLegacy.indexOf("09:30")).toBeLessThan(withLegacy.indexOf("09:52"));
    expect(withLegacy.indexOf("09:52")).toBeLessThan(withLegacy.indexOf("10:00"));
  });

  it("still accepts HH:MM, including an optional blank and a saved odd minute", () => {
    expect(parseTime(undefined).success).toBe(true);
    expect(parseTime(null).success).toBe(true);
    expect(parseTime("00:00").success).toBe(true);
    expect(parseTime("14:30").success).toBe(true);
    expect(parseTime("23:30").success).toBe(true);
    expect(parseTime("09:52").success).toBe(true);
    expect(parseTime("24:00").success).toBe(false);
    expect(parseTime("14:60").success).toBe(false);
    expect(parseTime("2:30 PM").success).toBe(false);
    expect(parseTime("14:30:00").success).toBe(false);
    expect(parseTime("1430").success).toBe(false);
  });

  it("sends null when the field is left blank and keeps 00:00", () => {
    expect(payloadFromDraft({ ...emptyDraft(), shipTime: "" }).shipTime).toBeNull();
    expect(payloadFromDraft({ ...emptyDraft(), shipTime: "00:00" }).shipTime).toBe("00:00");
    expect(payloadFromDraft({ ...emptyDraft(), shipTime: "23:30" }).shipTime).toBe("23:30");
  });
});
