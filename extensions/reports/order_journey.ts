/**
 * Order journey / timing report.
 *
 * @module
 */
import {
  orderJourney,
  type ReportContext,
  type ReportResult,
  runReport,
} from "./lib.ts";

/** Order-journey timeline report definition. */
export const report = {
  name: "@kneel/dominos-order-journey",
  description:
    "Per-stage timeline for the latest tracked order (placed -> prep -> bake -> quality-check) with durations, total time, and the store's ETA",
  scope: "model",
  labels: ["dominos", "timing"],
  execute: (context: ReportContext): Promise<ReportResult> =>
    runReport(context, orderJourney),
};
