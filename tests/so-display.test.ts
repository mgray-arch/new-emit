import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ListStopNames from "@/components/list-stop-names";
import SoNumber from "@/components/so-number";
import { listEndpointNames } from "@/lib/load-list";

describe("sales order display", () => {
  it("keeps the stored text and marks it for uppercase bold CSS", () => {
    const html = renderToStaticMarkup(createElement(SoNumber, null, "so-68341_t2"));
    expect(html).toBe('<span class="so-number">so-68341_t2</span>');
    expect(html).not.toContain("SO-68341_T2");
  });

  it("bolds the SO label and the number together without rewriting them", () => {
    const html = renderToStaticMarkup(createElement(SoNumber, null, "SO: so-68341_t2"));
    expect(html).toContain('class="so-number"');
    expect(html).toContain("SO: so-68341_t2");
  });
});

describe("list card location names", () => {
  it("uses the first pickup and the final delivery, and counts the stops between them", () => {
    const order = {
      origin: { company: "ignored when stops exist" },
      destination: { company: "ignored when stops exist" },
      stops: [
        { kind: "pickup", place: { company: "EMIT ALLEN" } },
        { kind: "pickup", place: { company: "EMIT NORTH" } },
        { kind: "drop", place: { company: "Yard" } },
        { kind: "drop", place: { company: "COMPASS COMPRESSION SOLUTIONS" } },
      ],
    };
    expect(listEndpointNames(order)).toEqual({
      pickup: "EMIT ALLEN",
      delivery: "COMPASS COMPRESSION SOLUTIONS",
      extraStops: 2,
    });
    expect(order.stops[1].place.company).toBe("EMIT NORTH");
  });

  it("falls back to origin and destination when the load has no stop list", () => {
    expect(
      listEndpointNames({
        origin: { company: "  EMIT ALLEN  " },
        destination: { company: "COMPASS COMPRESSION SOLUTIONS" },
        stops: [],
      }),
    ).toEqual({ pickup: "EMIT ALLEN", delivery: "COMPASS COMPRESSION SOLUTIONS", extraStops: 0 });
  });

  it("renders the names under Pickup and Delivery and leaves the stored spelling alone", () => {
    const html = renderToStaticMarkup(
      createElement(ListStopNames, {
        order: {
          origin: { company: "EMIT ALLEN" },
          destination: { company: "Compass Compression Solutions" },
          stops: [
            { kind: "pickup", place: { company: "EMIT ALLEN" } },
            { kind: "drop", place: { company: "Middle Yard" } },
            { kind: "drop", place: { company: "Compass Compression Solutions" } },
          ],
          shipDate: "2026-11-10",
          shipTime: "13:30",
          mustDeliverDate: null,
        },
      }),
    );
    expect(html).toContain("EMIT ALLEN");
    expect(html).toContain("Compass Compression Solutions");
    expect(html).not.toContain("Middle Yard");
    expect(html).toContain("Nov 10, 13:30");
    expect(html).toContain("Not set");
    expect(html).toContain("+1 stop");
    expect(html).toContain('class="place-name"');
    expect(html).not.toMatch(/\bSAM\b|carrier pay|\$/);
  });
});
