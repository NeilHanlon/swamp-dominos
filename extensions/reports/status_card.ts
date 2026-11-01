/**
 * "Where's my pizza" status card report.
 *
 * @module
 */
import {
  type ReportContext,
  type ReportResult,
  runReport,
  statusCard,
} from "./lib.ts";

/** Current-order status card report definition. */
export const report = {
  name: "@kneel/dominos-status-card",
  description:
    "Human-readable card for the latest tracked order: stage + progress bar, ETA, store, and items",
  scope: "model",
  labels: ["dominos", "status"],
  execute: (context: ReportContext): Promise<ReportResult> =>
    runReport(context, statusCard),
};
