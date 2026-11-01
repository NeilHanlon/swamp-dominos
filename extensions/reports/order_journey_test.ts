import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./order_journey.ts";
import type { ReportContext } from "./lib.ts";

function fakeContext(content: unknown | null): ReportContext {
  return {
    modelType: "@kneel/dominos",
    modelId: "pizza",
    dataRepository: {
      getContent: (_t, _id, name) => {
        if (name !== "order-status" || content === null) return null;
        return new TextEncoder().encode(JSON.stringify(content));
      },
    },
  };
}

Deno.test("order_journey: definition shape", () => {
  assertEquals(report.name, "@kneel/dominos-order-journey");
  assertEquals(report.scope, "model");
  assertEquals(report.labels.includes("timing"), true);
});

Deno.test("order_journey: reconstructs a timeline from one snapshot", async () => {
  const r = await report.execute(fakeContext({
    storeId: "4337",
    orderKey: "433700000000",
    serviceMethod: "Carry-Out",
    stage: "complete",
    estimatedWaitMinutes: "6-16",
    raw: {
      StartTime: "2026-10-31T17:54:36-04:00",
      OvenTime: "2026-10-31T17:57:15-04:00",
      OvenTimeSecs: 450,
      RackTime: "2026-10-31T18:03:46-04:00",
    },
  }));
  assertStringIncludes(r.markdown, "Order 4337/433700000000");
  assertStringIncludes(r.markdown, "9m10s");
  assertEquals(r.json.totalSecs, 550);
});

Deno.test("order_journey: no snapshot -> guidance", async () => {
  const r = await report.execute(fakeContext(null));
  assertStringIncludes(r.markdown, "Run the `track` method first");
});
