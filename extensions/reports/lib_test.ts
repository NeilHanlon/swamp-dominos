import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildJourney,
  clockOf,
  fmtDuration,
  orderJourney,
  progressBar,
  secondsBetween,
  statusCard,
} from "./lib.ts";
import type { OrderStatus } from "../models/dominos.ts";

/** A realistic completed carry-out snapshot (verified live 2026-10-31). */
function sampleStatus(): OrderStatus {
  return {
    fetchedAt: "2026-10-31T22:05:00Z",
    source: "tracker-v2",
    phoneLast4: "0100",
    storeId: "4337",
    orderId: "2026-10-31#000000",
    storeOrderId: null,
    orderKey: "433700000000",
    orderDescription: "1 Chicken Alfredo Pasta\n1 Stuffed Cheesy Bread",
    serviceMethod: "Carry-Out",
    stage: "complete",
    stageLabel: "Complete",
    progressPct: 100,
    rawStatus: "Complete",
    placedAt: "2026-10-31T17:54:36-04:00",
    estimatedWaitMinutes: "6-16",
    asOfTime: "2026-10-31T17:54:40-04:00",
    timings: {
      startTime: "2026-10-31T17:54:36-04:00",
      makeTime: "159",
      ovenTime: "2026-10-31T17:57:15-04:00",
      rackTime: "2026-10-31T18:03:46-04:00",
      routeTime: null,
      deliveryTime: null,
    },
    delivered: true,
    raw: {
      StartTime: "2026-10-31T17:54:36-04:00",
      MakeTimeSecs: 159,
      OvenTime: "2026-10-31T17:57:15-04:00",
      OvenTimeSecs: 450,
      RackTime: "2026-10-31T18:03:46-04:00",
      OrderStatus: "Complete",
      ServiceMethod: "Carry-Out",
    },
  };
}

Deno.test("progressBar: fill scales with percentage", () => {
  assertEquals(progressBar(0), "[----------]");
  assertEquals(progressBar(100), "[##########]");
  assertEquals(progressBar(50), "[#####-----]");
  assertEquals(progressBar(150), "[##########]"); // clamped
});

Deno.test("fmtDuration: minutes and seconds", () => {
  assertEquals(fmtDuration(159), "2m39s");
  assertEquals(fmtDuration(60), "1m");
  assertEquals(fmtDuration(45), "45s");
});

Deno.test("secondsBetween / clockOf", () => {
  assertEquals(
    secondsBetween("2026-10-31T17:54:36-04:00", "2026-10-31T17:57:15-04:00"),
    159,
  );
  assertEquals(secondsBetween("bad", "2026-10-31T17:57:15-04:00"), null);
  assertEquals(clockOf("2026-10-31T17:57:15-04:00"), "17:57");
});

Deno.test("statusCard: shows stage, bar, items", () => {
  const r = statusCard(sampleStatus());
  assertStringIncludes(r.markdown, "[##########] 100%  COMPLETE");
  assertStringIncludes(r.markdown, "Store 4337 / Carry-Out");
  assertStringIncludes(r.markdown, "ETA 6-16 min");
  assertStringIncludes(r.markdown, "- 1 Chicken Alfredo Pasta");
  assertEquals((r.json.items as string[]).length, 2);
});

Deno.test("buildJourney: reconstructs legs with durations", () => {
  const legs = buildJourney(sampleStatus().raw);
  assertEquals(legs.map((l) => l.stage), [
    "placed",
    "prep",
    "bake",
    "quality-check",
  ]);
  // prep = StartTime -> OvenTime = 159s (measured interval beats makeSecs)
  assertEquals(legs[1].durationSecs, 159);
  // bake = OvenTime -> RackTime = 391s
  assertEquals(legs[2].durationSecs, 391);
});

Deno.test("orderJourney: total time and ETA line", () => {
  const r = orderJourney(sampleStatus());
  // total placed -> quality-check = 17:54:36 -> 18:03:46 = 9m10s
  assertStringIncludes(r.markdown, "9m10s");
  assertStringIncludes(r.markdown, "store ETA said 6-16 min");
  assertEquals(r.json.totalSecs, 550);
});

Deno.test("orderJourney: no timing fields -> graceful", () => {
  const s = sampleStatus();
  s.raw = { OrderStatus: "Order Placed" };
  const r = orderJourney(s);
  assertStringIncludes(r.markdown, "No timing fields");
  assertEquals((r.json.legs as unknown[]).length, 0);
});
