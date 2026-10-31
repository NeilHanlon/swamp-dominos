import { assertEquals } from "jsr:@std/assert@1";
import {
  adjustForService,
  extractOrders,
  mapStage,
  maskPhone,
  normalizeOrder,
  parseLegacyXml,
  pick,
  sanitizePhone,
  stageProgress,
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
  assertEquals(adjustForService("delivered", "Pickup"), "ready-for-pickup");
  assertEquals(adjustForService("bake", "Carryout"), "bake");
  assertEquals(adjustForService("out-for-delivery", "Delivery"), "out-for-delivery");
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

Deno.test("parseLegacyXml: pulls known flat fields", () => {
  const xml =
    "<root><StoreID>4337</StoreID><OrderStatus>Bake</OrderStatus>" +
    "<OrderKey>abc-123</OrderKey><ServiceMethod>Delivery</ServiceMethod></root>";
  const out = parseLegacyXml(xml);
  assertEquals(out.StoreID, "4337");
  assertEquals(out.OrderStatus, "Bake");
  assertEquals(out.OrderKey, "abc-123");
  assertEquals(out.ServiceMethod, "Delivery");
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

Deno.test("normalizeOrder: carryout ready for pickup is terminal", () => {
  const s = normalizeOrder(
    { OrderStatus: "Out the Door", ServiceMethod: "Carryout" },
    { fetchedAt: "2026-10-31T22:05:00Z", source: "tracker-v2", phoneLast4: null },
  );
  assertEquals(s.stage, "ready-for-pickup");
  assertEquals(s.delivered, true);
});
