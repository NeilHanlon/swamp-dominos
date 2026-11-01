/**
 * Shared report logic for the @kneel/dominos extension.
 *
 * Pure compute functions that turn the latest `order-status` snapshot into
 * markdown + JSON, plus a `runReport` helper that loads the snapshot and hands
 * it to a compute function. Not a report entrypoint itself — it exports no
 * `report`, so the loader skips it and each report file delegates here.
 *
 * Both reports read a single `order-status` snapshot: the Domino's detail
 * record carries the full per-stage timeline in one payload (StartTime, the
 * *TimeSecs durations, and the OvenTime / RackTime absolute marks), so no
 * cross-version polling is needed.
 *
 * @module
 */
import { type OrderStatus, STAGE_LABEL } from "../models/dominos.ts";

// ---------------------------------------------------------------------------
// Report wiring
// ---------------------------------------------------------------------------

/** Markdown + JSON produced by a report. */
export interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

/** Minimal view of the data repository passed to a report context. */
export interface DataRepository {
  getContent: (
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ) => Promise<Uint8Array | null> | Uint8Array | null;
}

/** The subset of the swamp report context these reports use. */
export interface ReportContext {
  modelType: unknown;
  modelId: string;
  dataRepository: DataRepository;
}

/** A swamp report definition. */
export interface ReportDefinition {
  name: string;
  description: string;
  scope: "model";
  labels: string[];
  execute: (context: ReportContext) => Promise<ReportResult>;
}

/** A pure compute function that renders a snapshot into a report result. */
export type Compute = (status: OrderStatus) => ReportResult;

/** Parse an `order-status` snapshot from raw bytes. */
export function parseOrderStatus(bytes: Uint8Array): OrderStatus {
  return JSON.parse(new TextDecoder().decode(bytes)) as OrderStatus;
}

/** Load the latest `order-status` snapshot and render it with `compute`. */
export async function runReport(
  context: ReportContext,
  compute: Compute,
): Promise<ReportResult> {
  const bytes = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    "order-status",
  );
  if (!bytes) {
    return {
      markdown:
        "## Domino's\n\n_No `order-status` snapshot found. Run the `track` method first._",
      json: { error: false, message: "no order-status snapshot" },
    };
  }
  return compute(parseOrderStatus(bytes));
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure)
// ---------------------------------------------------------------------------

/** First non-null/non-empty string from a raw record, by case-exact keys. */
function rawStr(
  raw: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return null;
}

function rawNum(
  raw: Record<string, unknown>,
  ...keys: string[]
): number | null {
  const s = rawStr(raw, ...keys);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A 10-cell ASCII progress bar for a 0-100 percentage. */
export function progressBar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

/** Human-friendly duration from whole seconds, e.g. 159 -> "2m39s". */
export function fmtDuration(totalSecs: number): string {
  const s = Math.max(0, Math.round(totalSecs));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  if (rem === 0) return `${m}m`;
  return `${m}m${rem}s`;
}

/** Seconds between two ISO timestamps, or null if either is unparseable. */
export function secondsBetween(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return (tb - ta) / 1000;
}

/** Local clock HH:MM from an ISO timestamp (keeps the offset's wall time). */
export function clockOf(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : iso;
}

// ---------------------------------------------------------------------------
// Report: "Where's my pizza" status card
// ---------------------------------------------------------------------------

/** Render the current order status as a human-readable card. */
export function statusCard(s: OrderStatus): ReportResult {
  const bar = progressBar(s.progressPct);
  const items = (s.orderDescription ?? "").split("\n").map((l) => l.trim())
    .filter(Boolean);
  const eta = s.estimatedWaitMinutes
    ? `   ETA ${s.estimatedWaitMinutes} min`
    : "";
  const lines = [
    `## Domino's — Where's my pizza?`,
    "",
    "```",
    `${bar} ${s.progressPct}%  ${s.stageLabel.toUpperCase()}`,
    `Store ${s.storeId ?? "?"} / ${s.serviceMethod ?? "?"}${eta}`,
    "```",
    "",
    ...(items.length
      ? ["**Order**", ...items.map((i) => `- ${i}`)]
      : ["_No item description._"]),
  ];
  return {
    markdown: lines.join("\n"),
    json: {
      stage: s.stage,
      stageLabel: s.stageLabel,
      progressPct: s.progressPct,
      serviceMethod: s.serviceMethod,
      storeId: s.storeId,
      estimatedWaitMinutes: s.estimatedWaitMinutes,
      delivered: s.delivered,
      items,
    },
  };
}

// ---------------------------------------------------------------------------
// Report: order journey / timing
// ---------------------------------------------------------------------------

/** One reconstructed leg of the order's journey. */
export interface JourneyLeg {
  stage: string;
  label: string;
  at: string | null;
  durationSecs: number | null;
}

/**
 * Reconstruct the per-stage timeline from a single detail snapshot's timing
 * fields. Domino's gives us StartTime (order taken) plus the make duration
 * (MakeTimeSecs), the oven mark + duration (OvenTime / OvenTimeSecs) and the
 * rack mark (RackTime). We derive each leg's wall-clock start and its duration.
 */
export function buildJourney(raw: Record<string, unknown>): JourneyLeg[] {
  const start = rawStr(raw, "StartTime", "OrderTakeCompleteTime");
  const ovenAt = rawStr(raw, "OvenTime");
  const rackAt = rawStr(raw, "RackTime");
  const makeSecs = rawNum(raw, "MakeTimeSecs");
  const ovenSecs = rawNum(raw, "OvenTimeSecs");

  const legs: JourneyLeg[] = [];
  if (start) {
    legs.push({
      stage: "placed",
      label: STAGE_LABEL["placed"],
      at: start,
      durationSecs: null,
    });
    // Prep spans from order-taken to oven-in; prefer the measured interval,
    // fall back to the reported make duration.
    const prepDur = ovenAt ? secondsBetween(start, ovenAt) : null;
    legs.push({
      stage: "prep",
      label: STAGE_LABEL["prep"],
      at: start,
      durationSecs: prepDur ?? makeSecs,
    });
  }
  if (ovenAt) {
    const bakeDur = rackAt ? secondsBetween(ovenAt, rackAt) : null;
    legs.push({
      stage: "bake",
      label: STAGE_LABEL["bake"],
      at: ovenAt,
      durationSecs: bakeDur ?? ovenSecs,
    });
  }
  if (rackAt) {
    legs.push({
      stage: "quality-check",
      label: STAGE_LABEL["quality-check"],
      at: rackAt,
      durationSecs: null,
    });
  }
  return legs;
}

/** Render the order journey (per-stage timeline + total + ETA vs actual). */
export function orderJourney(s: OrderStatus): ReportResult {
  const legs = buildJourney(s.raw);
  if (legs.length === 0) {
    return {
      markdown:
        `## Domino's — Order journey\n\n_No timing fields on the snapshot yet (stage: ${s.stage})._`,
      json: { stage: s.stage, legs: [] },
    };
  }
  const first = legs[0].at;
  const last = legs[legs.length - 1].at;
  const totalSecs = first && last ? secondsBetween(first, last) : null;

  const rows = legs.map((l) => {
    const clock = l.at ? clockOf(l.at) : "--:--";
    const dur = l.durationSecs !== null
      ? `+${fmtDuration(l.durationSecs)}`
      : "";
    return `  ${l.label.padEnd(16)} ${clock}  ${dur}`;
  });

  const totalLine = totalSecs !== null
    ? `  total ${legs[0].stage} -> ${legs[legs.length - 1].stage}: ${
      fmtDuration(totalSecs)
    }`
    : "";
  const etaLine = s.estimatedWaitMinutes
    ? `  (store ETA said ${s.estimatedWaitMinutes} min)`
    : "";

  const md = [
    `## Domino's — Order journey`,
    "",
    "```",
    `Order ${s.storeId ?? "?"}/${s.orderKey ?? "?"}  (${
      s.serviceMethod ?? "?"
    })`,
    ...rows,
    "  " + "-".repeat(34),
    totalLine,
    etaLine,
    "```",
  ].filter((l) => l !== "").join("\n");

  return {
    markdown: md,
    json: {
      stage: s.stage,
      storeId: s.storeId,
      orderKey: s.orderKey,
      serviceMethod: s.serviceMethod,
      estimatedWaitMinutes: s.estimatedWaitMinutes,
      totalSecs,
      legs,
    },
  };
}
