import { assertEquals } from "jsr:@std/assert@1";
import {
  adjustForService,
  extractOrders,
  mapStage,
  maskPhone,
  normalizeOrder,
  pick,
  redactPhoneFields,
  sanitizePhone,
  stageProgress,
  trackPathOf,
} from "./dominos.ts";

Deno.test("mapStage: legacy phase names", () => {
  assertEquals(mapStage("Order Placed"), "placed");
  assertEquals(mapStage("Prep"), "prep");
  assertEquals(mapStage("Bake"), "bake");
  assertEquals(mapStage("Routing Station"), "quality-check");
  assertEquals(mapStage("Out the Door"), "out-for-delivery");
  assertEquals(mapStage("Delivered"), "delivered");
  assertEquals(mapStage("Complete"), "complete");
});

Deno.test("mapStage: newer simplified labels", () => {
  assertEquals(mapStage("make"), "prep");
  assertEquals(mapStage("out for delivery"), "out-for-delivery");
  assertEquals(mapStage("mmm"), "complete");
});

Deno.test("mapStage: empty / unknown", () => {
  assertEquals(mapStage(""), "unknown");
  assertEquals(mapStage("   "), "unknown");
  assertEquals(mapStage("flux capacitor charging"), "unknown");
});

Deno.test("mapStage: latest phase wins over earlier substrings", () => {
  // Contains both "bake" and "out for delivery" — the later phase must win.
  assertEquals(mapStage("baked, now out for delivery"), "out-for-delivery");
});

Deno.test("adjustForService: carryout remaps delivery -> pickup", () => {
  assertEquals(adjustForService("out-for-delivery", "Carryout"), "ready-for-pickup");
  // Live API returns "Carry-Out" (hyphen) — punctuation must not defeat it.
  assertEquals(adjustForService("out-for-delivery", "Carry-Out"), "ready-for-pickup");
  assertEquals(adjustForService("delivered", "Pickup"), "ready-for-pickup");
  assertEquals(adjustForService("bake", "Carry-Out"), "bake");
  assertEquals(adjustForService("out-for-delivery", "Delivery"), "out-for-delivery");
});

Deno.test("trackPathOf: reads Actions.Track, else null", () => {
  assertEquals(
    trackPathOf({ Actions: { Track: "/v2/orders/stores/4337/orderkeys/1" } }),
    "/v2/orders/stores/4337/orderkeys/1",
  );
  assertEquals(trackPathOf({ Actions: {} }), null);
  assertEquals(trackPathOf({ OrderID: "x" }), null);
});

Deno.test("stageProgress: monotonic pipeline", () => {
  assertEquals(stageProgress("placed"), 0);
  assertEquals(stageProgress("complete"), 100);
  assertEquals(stageProgress("ready-for-pickup"), stageProgress("delivered"));
  assertEquals(stageProgress("unknown"), 0);
});

Deno.test("sanitizePhone: strips punctuation and US country code", () => {
  assertEquals(sanitizePhone("(617) 555-1234"), "6175551234");
  assertEquals(sanitizePhone("+1 617-555-1234"), "6175551234");
  assertEquals(sanitizePhone("16175551234"), "6175551234");
});

Deno.test("maskPhone: only last 4 survive", () => {
  assertEquals(maskPhone("(617) 555-1234"), "***-***-1234");
  assertEquals(maskPhone("12"), "***");
});

Deno.test("pick: case-insensitive with fallbacks, skips empty", () => {
  const o = { StoreID: "4337", orderStatus: "" , Status: "Bake" };
  assertEquals(pick(o, "storeid"), "4337");
  // orderStatus is empty string -> fall through to Status
  assertEquals(pick(o, "OrderStatus", "Status"), "Bake");
  assertEquals(pick(o, "missing"), undefined);
});

Deno.test("extractOrders: bare array, Orders, orders, else empty", () => {
  assertEquals(extractOrders([{ a: 1 }]).length, 1);
  assertEquals(extractOrders({ Orders: [{ a: 1 }, { b: 2 }] }).length, 2);
  assertEquals(extractOrders({ orders: [{ a: 1 }] }).length, 1);
  assertEquals(extractOrders({ nope: true }).length, 0);
  assertEquals(extractOrders(null).length, 0);
});

Deno.test("normalizeOrder: delivery order in the oven", () => {
  const s = normalizeOrder(
    {
      StoreID: "4337",
      OrderID: "99",
      StoreOrderID: "SO-1",
      OrderStatus: "Bake",
      ServiceMethod: "Delivery",
      OrderDescription: "1 Large Pepperoni",
      StartTime: "2026-10-31T22:00:00Z",
    },
    { fetchedAt: "2026-10-31T22:05:00Z", source: "tracker-v2", phoneLast4: "1234" },
  );
  assertEquals(s.stage, "bake");
  assertEquals(s.storeId, "4337");
  assertEquals(s.orderKey, "SO-1"); // falls back to StoreOrderID
  assertEquals(s.phoneLast4, "1234");
  assertEquals(s.delivered, false);
  assertEquals(s.placedAt, "2026-10-31T22:00:00Z");
  assertEquals(s.raw.StoreID, "4337");
});

Deno.test("redactPhoneFields: masks phone-ish keys, recurses, keeps rest", () => {
  const out = redactPhoneFields({
    StoreID: "4337",
    Phone: "6175551234",
    customer: { PhoneNumber: "16175559999", name: "Neil" },
    items: [{ phone: "5551112222" }],
  });
  assertEquals(out.StoreID, "4337");
  assertEquals(out.Phone, "***-***-1234");
  assertEquals((out.customer as Record<string, unknown>).PhoneNumber, "***-***-9999");
  assertEquals((out.customer as Record<string, unknown>).name, "Neil");
  assertEquals((out.items as Array<Record<string, unknown>>)[0].phone, "***-***-2222");
});

Deno.test("normalizeOrder: raw passthrough is phone-redacted", () => {
  const s = normalizeOrder(
    { OrderStatus: "Bake", Phone: "6175551234" },
    { fetchedAt: "2026-10-31T22:05:00Z", source: "tracker-v2", phoneLast4: "1234" },
  );
  assertEquals(s.raw.Phone, "***-***-1234");
});

Deno.test("normalizeOrder: completed carry-out detail (real-shape)", () => {
  // Mirrors the live tracker detail payload verified 2026-10-31.
  const s = normalizeOrder(
    {
      OrderStatus: "Complete",
      ServiceMethod: "Carry-Out",
      StoreID: "4337",
      OrderKey: "433700000000",
      StartTime: "2026-10-31T17:54:36-04:00",
      EstimatedWaitMinutes: "6-16",
      StoreAsOfTime: "2026-10-31T18:10:00-04:00",
      Phone: "5555550100",
    },
    { fetchedAt: "2026-10-31T22:05:00Z", source: "tracker-v2", phoneLast4: "8171" },
  );
  assertEquals(s.stage, "complete");
  assertEquals(s.delivered, true);
  assertEquals(s.estimatedWaitMinutes, "6-16");
  assertEquals(s.asOfTime, "2026-10-31T18:10:00-04:00");
  assertEquals(s.raw.Phone, "***-***-8171"); // redacted in raw
});

Deno.test("normalizeOrder: in-progress carry-out out the door -> ready for pickup", () => {
  const s = normalizeOrder(
    { OrderStatus: "Out the Door", ServiceMethod: "Carry-Out" },
    { fetchedAt: "2026-10-31T22:05:00Z", source: "tracker-v2", phoneLast4: null },
  );
  assertEquals(s.stage, "ready-for-pickup");
  assertEquals(s.delivered, true);
});
