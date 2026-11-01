import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./status_card.ts";
import type { ReportContext } from "./lib.ts";

/** A fake data repository that serves fixed bytes for `order-status`. */
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

Deno.test("status_card: definition shape", () => {
  assertEquals(report.name, "@kneel/dominos-status-card");
  assertEquals(report.scope, "model");
  assertEquals(report.labels.includes("dominos"), true);
});

Deno.test("status_card: renders the latest snapshot", async () => {
  const r = await report.execute(fakeContext({
    orderDescription: "1 Large Pepperoni",
    serviceMethod: "Delivery",
    storeId: "4337",
    stage: "bake",
    stageLabel: "Bake (oven)",
    progressPct: 40,
    estimatedWaitMinutes: "20-30",
    raw: {},
  }));
  assertStringIncludes(r.markdown, "40%  BAKE");
  assertStringIncludes(r.markdown, "- 1 Large Pepperoni");
  assertEquals(r.json.stage, "bake");
});

Deno.test("status_card: no snapshot -> guidance", async () => {
  const r = await report.execute(fakeContext(null));
  assertStringIncludes(r.markdown, "Run the `track` method first");
});
