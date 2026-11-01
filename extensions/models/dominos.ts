/**
 * Domino's pizza-tracker behavior.
 *
 * A read-only tracker for a Domino's order: given the phone number the order
 * was placed under (or a Store ID + Order Key), it polls Domino's public
 * tracker-presentation-service (v2 JSON) and persists a normalized order-status
 * snapshot with a canonical stage (placed -> prep -> bake -> quality-check ->
 * out-for-delivery | ready-for-pickup -> delivered -> complete).
 *
 * The phone lookup returns only order "directory" records (an `Actions.Track`
 * path, no live status); the status comes from a second call to that path. The
 * service requires `dpz-market` / `dpz-language` headers or it answers 400;
 * there is no auth token.
 *
 * The phone number is PII, not a secret — it is never persisted or logged in
 * full, only masked to its last four digits (including inside the `raw`
 * passthrough, via redactPhoneFields).
 *
 * The upstream field shapes drift between Domino's releases, so the response
 * schemas are deliberately tolerant (raw records pass through) and the
 * normalizer reads known fields case-insensitively with fallbacks. The `raw`
 * field on every snapshot preserves the untouched upstream object.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  phone: z.string().optional().meta({ sensitive: true }).describe(
    "Default phone number the order was placed under (any format; non-digits are stripped). PII — persisted only as last-4. Override per call.",
  ),
  storeId: z.string().optional().describe(
    "Default Domino's Store ID, for track-by-order (used with orderKey).",
  ),
  orderKey: z.string().optional().describe(
    "Default Order Key / Store Order ID, for track-by-order (used with storeId).",
  ),
  trackerBaseUrl: z.url().default("https://tracker.dominos.com").describe(
    "Tracker presentation service base URL (modern JSON API).",
  ),
  market: z.string().default("UNITED_STATES").describe(
    "dpz-market header value. US tracker is UNITED_STATES; other markets vary.",
  ),
  language: z.string().default("en").describe(
    "dpz-language header value (e.g. en).",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Canonical stages
// ---------------------------------------------------------------------------

/**
 * Canonical, service-agnostic order stages in progress order. `delivered` and
 * `ready-for-pickup` are the two terminal "handed off" states; `complete` is
 * Domino's own final marker. `unknown` is the safe default when upstream status
 * text matches nothing known.
 */
export const STAGES = [
  "placed",
  "prep",
  "bake",
  "quality-check",
  "out-for-delivery",
  "ready-for-pickup",
  "delivered",
  "complete",
  "unknown",
] as const;

export type Stage = (typeof STAGES)[number];

const StageEnum = z.enum(STAGES);

/** Ordered pipeline used to compute a coarse progress percentage. */
const PROGRESS_ORDER: Stage[] = [
  "placed",
  "prep",
  "bake",
  "quality-check",
  "out-for-delivery",
  "delivered",
  "complete",
];

/** Human label for each canonical stage. */
export const STAGE_LABEL: Record<Stage, string> = {
  "placed": "Order Placed",
  "prep": "Prep (make line)",
  "bake": "Bake (oven)",
  "quality-check": "Quality Check",
  "out-for-delivery": "Out for Delivery",
  "ready-for-pickup": "Ready for Pickup",
  "delivered": "Delivered",
  "complete": "Complete",
  "unknown": "Unknown",
};

/**
 * Map free-form Domino's status text to a canonical base stage. Matching is
 * substring-based and lowercased so it tolerates both the legacy phase names
 * ("Routing Station", "Out the Door") and the newer simplified labels
 * ("make", "deliver", "mmm"). Order matters: the most specific / latest phases
 * are tested first so e.g. "out for delivery" wins over a stray "deliver".
 */
export function mapStage(statusText: string): Stage {
  const s = (statusText ?? "").toLowerCase();
  if (!s.trim()) return "unknown";
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));

  if (has("complete", "mmm", "enjoy")) return "complete";
  if (has("delivered")) return "delivered";
  if (has("out for delivery", "out the door", "on the way", "leftstore")) {
    return "out-for-delivery";
  }
  if (has("ready", "pickup", "carryout ready")) return "ready-for-pickup";
  if (has("quality", "routing", "rack", "boxed", "box")) {
    return "quality-check";
  }
  if (has("bake", "oven")) return "bake";
  if (has("prep", "make", "makeline", "making")) return "prep";
  if (has("placed", "new order", "received", "pending")) return "placed";
  return "unknown";
}

/**
 * Carryout orders never "go out for delivery" — their out-the-door phase means
 * the pizza is ready at the counter. Remap the delivery-ish stages onto the
 * pickup terminal when the service method is a carryout/pickup.
 */
export function adjustForService(stage: Stage, serviceMethod: string): Stage {
  // Collapse punctuation so "Carry-Out", "Carry Out" and "Carryout" all match.
  const norm = (serviceMethod ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const isCarryout = norm.includes("carryout") || norm.includes("pickup");
  if (!isCarryout) return stage;
  if (stage === "out-for-delivery" || stage === "delivered") {
    return "ready-for-pickup";
  }
  return stage;
}

/** Coarse 0-100 progress for a stage (terminal pickup counts as delivered). */
export function stageProgress(stage: Stage): number {
  const effective = stage === "ready-for-pickup" ? "delivered" : stage;
  const idx = PROGRESS_ORDER.indexOf(effective);
  if (idx < 0) return 0;
  return Math.round((idx / (PROGRESS_ORDER.length - 1)) * 100);
}

// ---------------------------------------------------------------------------
// Phone helpers (PII — never persist or log in full)
// ---------------------------------------------------------------------------

/** Strip everything but digits; drop a leading US country code "1" if present. */
export function sanitizePhone(raw: string): string {
  let digits = (raw ?? "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

/** Last-4 mask for a (sanitized or raw) phone number, e.g. "***-***-1234". */
export function maskPhone(raw: string): string {
  const d = sanitizePhone(raw);
  if (d.length < 4) return "***";
  return `***-***-${d.slice(-4)}`;
}

/**
 * Deep-clone a record, masking any field whose key contains "phone" to its
 * last-4. The upstream order object contains the customer's full phone number;
 * since we persist the raw object verbatim, this is the single choke point that
 * keeps the full number out of stored data. Recurses through nested
 * objects/arrays. String phone values are masked; non-strings are nulled.
 */
export function redactPhoneFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactPhoneFields(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/phone/i.test(k)) {
        out[k] = typeof v === "string" ? maskPhone(v) : null;
      } else {
        out[k] = redactPhoneFields(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tolerant field access over drifting upstream records
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

/** First defined value among `keys`, matched case-insensitively. */
export function pick(obj: Loose, ...keys: string[]): unknown {
  if (!obj) return undefined;
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) lower.set(k.toLowerCase(), v);
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function pickStr(obj: Loose, ...keys: string[]): string | null {
  const v = pick(obj, ...keys);
  return v === undefined ? null : String(v);
}

// ---------------------------------------------------------------------------
// Schemas (tolerant: the raw upstream object always passes through)
// ---------------------------------------------------------------------------

const RawRecord = z.record(z.string(), z.unknown());

const TimingsSchema = z.object({
  startTime: z.string().nullable(),
  makeTime: z.string().nullable(),
  ovenTime: z.string().nullable(),
  rackTime: z.string().nullable(),
  routeTime: z.string().nullable(),
  deliveryTime: z.string().nullable(),
});

const OrderStatusSchema = z.object({
  fetchedAt: z.iso.datetime(),
  source: z.literal("tracker-v2"),
  phoneLast4: z.string().nullable(),
  storeId: z.string().nullable(),
  orderId: z.string().nullable(),
  storeOrderId: z.string().nullable(),
  orderKey: z.string().nullable(),
  orderDescription: z.string().nullable(),
  serviceMethod: z.string().nullable(),
  stage: StageEnum,
  stageLabel: z.string(),
  progressPct: z.number(),
  rawStatus: z.string().nullable(),
  placedAt: z.string().nullable(),
  estimatedWaitMinutes: z.string().nullable(),
  asOfTime: z.string().nullable(),
  timings: TimingsSchema,
  delivered: z.boolean(),
  raw: RawRecord,
});

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

const OrdersSchema = z.object({
  fetchedAt: z.iso.datetime(),
  phoneLast4: z.string().nullable(),
  count: z.number(),
  orders: z.array(RawRecord),
});

// ---------------------------------------------------------------------------
// Normalization (pure — unit-testable without a network)
// ---------------------------------------------------------------------------

/**
 * Normalize one upstream order record into an {@link OrderStatus}. Reads known
 * fields case-insensitively with fallbacks, derives the canonical stage from
 * the status text adjusted for the service method, and keeps the untouched
 * record under `raw`.
 */
export function normalizeOrder(
  order: Loose,
  opts: {
    fetchedAt: string;
    source: "tracker-v2";
    phoneLast4: string | null;
  },
): OrderStatus {
  const serviceMethod = pickStr(order, "ServiceMethod", "serviceMethod") ?? "";
  const rawStatus = pickStr(
    order,
    "OrderStatus",
    "orderStatus",
    "Status",
    "status",
  );
  const orderDescription = pickStr(
    order,
    "OrderDescription",
    "orderDescription",
  );
  // Feed every status-bearing signal into the mapper, then service-adjust.
  const base = mapStage(
    [rawStatus, orderDescription, serviceMethod].filter(Boolean).join(" "),
  );
  const stage = adjustForService(base, serviceMethod);
  const storeOrderId = pickStr(order, "StoreOrderID", "storeOrderId");
  const timings: z.infer<typeof TimingsSchema> = {
    startTime: pickStr(order, "StartTime", "startTime"),
    makeTime: pickStr(order, "MakeTimeSecs", "MakeTime", "makeTime"),
    ovenTime: pickStr(order, "OvenTime", "ovenTime"),
    rackTime: pickStr(order, "RackTime", "rackTime"),
    routeTime: pickStr(order, "RouteTime", "routeTime"),
    deliveryTime: pickStr(order, "DeliveryTime", "deliveryTime"),
  };
  return {
    fetchedAt: opts.fetchedAt,
    source: opts.source,
    phoneLast4: opts.phoneLast4,
    storeId: pickStr(order, "StoreID", "storeId", "StoreId"),
    orderId: pickStr(order, "OrderID", "orderId"),
    storeOrderId,
    orderKey: pickStr(order, "OrderKey", "orderKey") ?? storeOrderId,
    orderDescription,
    serviceMethod: serviceMethod || null,
    stage,
    stageLabel: STAGE_LABEL[stage],
    progressPct: stageProgress(stage),
    rawStatus,
    placedAt: timings.startTime,
    estimatedWaitMinutes: pickStr(order, "EstimatedWaitMinutes"),
    asOfTime: pickStr(order, "StoreAsOfTime", "AsOfTime"),
    timings,
    delivered: stage === "delivered" || stage === "complete" ||
      stage === "ready-for-pickup",
    raw: redactPhoneFields(order),
  };
}

/**
 * Pull the array of order objects out of a tracker-v2 response. The service has
 * returned the list under a few shapes across releases (bare array, `Orders`,
 * `orders`); accept all and fall back to an empty list.
 */
export function extractOrders(resp: unknown): Loose[] {
  if (Array.isArray(resp)) return resp as Loose[];
  if (resp && typeof resp === "object") {
    const o = resp as Loose;
    const cand = o.Orders ?? o.orders ?? o.Result ?? o.result;
    if (Array.isArray(cand)) return cand as Loose[];
  }
  return [];
}

/** Extract the `Actions.Track` detail path from a phone-lookup order record. */
export function trackPathOf(order: Loose): string | null {
  const actions = order.Actions ?? order.actions;
  if (actions && typeof actions === "object") {
    const t = (actions as Loose).Track ?? (actions as Loose).track;
    if (typeof t === "string" && t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const TRACKER_PREFIX = "/tracker-presentation-service";

/**
 * The tracker service rejects requests (400) without its market/language
 * headers, so every call carries them. No auth token is involved.
 */
function trackerHeaders(g: GlobalArgs): Record<string, string> {
  return {
    "accept": "application/json",
    "content-type": "application/json; charset=utf-8",
    "dpz-language": g.language,
    "dpz-market": g.market,
  };
}

async function trackerGet(g: GlobalArgs, url: string): Promise<unknown> {
  const r = await fetch(url, { headers: trackerHeaders(g) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `Domino's tracker GET failed: ${r.status} ${r.statusText} ${
        body.slice(0, 200)
      }`,
    );
  }
  return await r.json();
}

/**
 * Phone lookup. Returns an array of order "directory" records — each carries an
 * `Actions.Track` path but NOT the live status; the status comes from a second
 * call to that path (see {@link fetchDetailByPath}).
 */
async function fetchByPhone(g: GlobalArgs, phone: string): Promise<Loose[]> {
  const base = g.trackerBaseUrl.replace(/\/+$/, "");
  const url = `${base}${TRACKER_PREFIX}/v2/orders?phonenumber=${phone}`;
  return extractOrders(await trackerGet(g, url));
}

/** Fetch the detailed status record for an `Actions.Track` path. */
async function fetchDetailByPath(g: GlobalArgs, path: string): Promise<Loose> {
  const base = g.trackerBaseUrl.replace(/\/+$/, "");
  // The path already begins with "/v2/..."; join onto the service prefix.
  const rel = path.replace(/^\/+/, "");
  const url = `${base}${TRACKER_PREFIX}/${rel}`;
  return (await trackerGet(g, url)) as Loose;
}

/** Fetch the detailed status record directly by Store ID + Order Key. */
async function fetchDetailByOrder(
  g: GlobalArgs,
  storeId: string,
  orderKey: string,
): Promise<Loose> {
  const base = g.trackerBaseUrl.replace(/\/+$/, "");
  const url = `${base}${TRACKER_PREFIX}/v2/orders/stores/${
    encodeURIComponent(storeId)
  }/orderkeys/${encodeURIComponent(orderKey)}`;
  return (await trackerGet(g, url)) as Loose;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const TrackArgs = z.object({
  phone: z.string().optional().describe(
    "Phone the order was placed under (overrides the global default).",
  ),
  storeId: z.string().optional().describe(
    "Store ID for track-by-order (with orderKey). Overrides global.",
  ),
  orderKey: z.string().optional().describe(
    "Order Key / Store Order ID for track-by-order (with storeId).",
  ),
  index: z.number().int().min(0).default(0).describe(
    "Which order from the phone lookup to normalize (0 = most recent).",
  ),
});

const ListOrdersArgs = z.object({
  phone: z.string().optional().describe(
    "Phone to look up recent orders for (overrides the global default).",
  ),
});

// ---------------------------------------------------------------------------
// Context contract (provided by the swamp runtime)
// ---------------------------------------------------------------------------

interface DataHandle {
  name: string;
}

interface Logger {
  info: (message: string, properties?: Record<string, unknown>) => void;
  warning: (message: string, properties?: Record<string, unknown>) => void;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
}

// ---------------------------------------------------------------------------
// Behavior definition
// ---------------------------------------------------------------------------

/** Domino's pizza-tracker behavior type. */
export const model = {
  type: "@kneel/dominos",
  version: "2026.10.31.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],
  resources: {
    "order-status": {
      description:
        "Normalized snapshot of a single order's current tracker stage",
      schema: OrderStatusSchema,
      lifetime: "7d",
      garbageCollection: 25,
    },
    "orders": {
      description: "Raw list of recent orders returned by a phone lookup",
      schema: OrdersSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  reports: [
    "@kneel/dominos-status-card",
    "@kneel/dominos-order-journey",
  ],
  checks: {
    "tracker-reachable": {
      description:
        "Verify the Domino's tracker endpoint is reachable and a phone or store+order is configured before tracking",
      labels: ["live"],
      appliesTo: ["track"],
      execute: async (
        context: { globalArgs: GlobalArgs; logger: Logger },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const g = context.globalArgs;
        // NOTE: checks receive only globalArgs, never the per-call method
        // arguments — so we cannot assert a target here (phone/storeId/orderKey
        // may legitimately be passed per call). Target presence is validated
        // inside the method. This check verifies reachability only.
        try {
          const r = await fetch(
            `${g.trackerBaseUrl.replace(/\/+$/, "")}/`,
            { method: "HEAD" },
          );
          // Any HTTP answer proves reachability; status code is irrelevant here.
          context.logger.info("Domino's tracker reachable ({status})", {
            status: r.status,
          });
          return { pass: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            pass: false,
            errors: [`Domino's tracker is not reachable: ${message}`],
          };
        }
      },
    },
  },
  methods: {
    track: {
      description:
        "Fetch and persist the current tracker status for one order (by phone, or by storeId+orderKey)",
      arguments: TrackArgs,
      execute: async (
        a: z.infer<typeof TrackArgs>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const fetchedAt = nowIso();
        const storeId = a.storeId ?? g.storeId;
        const orderKey = a.orderKey ?? g.orderKey;
        const rawPhone = a.phone ?? g.phone;

        // Track-by-order: one direct detail call, no phone lookup.
        if (storeId && orderKey) {
          context.logger.info(
            "Tracking Domino's order by store/order ({store})",
            { store: storeId },
          );
          const detail = await fetchDetailByOrder(g, storeId, orderKey);
          const phoneLast4 = detail.Phone
            ? sanitizePhone(String(detail.Phone)).slice(-4)
            : null;
          const status = normalizeOrder(detail, {
            fetchedAt,
            source: "tracker-v2",
            phoneLast4,
          });
          const handle = await context.writeResource(
            "order-status",
            "order-status",
            status as unknown as Record<string, unknown>,
          );
          context.logger.info("Order stage: {stage} ({pct}%)", {
            stage: status.stage,
            pct: status.progressPct,
          });
          return { dataHandles: [handle] };
        }

        if (!rawPhone) {
          throw new Error(
            "No tracker target: provide `phone`, or both `storeId` and `orderKey`.",
          );
        }
        const phone = sanitizePhone(rawPhone);
        if (phone.length < 10) {
          throw new Error(
            `Phone must have 10 digits after sanitizing; got ${phone.length}.`,
          );
        }
        const last4 = phone.slice(-4);
        context.logger.info("Tracking Domino's order by phone (***-***-{l})", {
          l: last4,
        });
        // Step 1: phone lookup -> order "directory" records (no status).
        // Redact at the boundary: the full phone can appear inside each record,
        // and last4 comes from the caller's input, not these records.
        const orders = (await fetchByPhone(g, phone)).map((o) =>
          redactPhoneFields(o)
        );
        const handles: DataHandle[] = [];
        handles.push(
          await context.writeResource("orders", "orders", {
            fetchedAt,
            phoneLast4: last4,
            count: orders.length,
            orders,
          }),
        );
        if (orders.length === 0) {
          context.logger.warning(
            "No active orders found for ***-***-{l}",
            { l: last4 },
          );
          return { dataHandles: handles };
        }
        // Step 2: follow the chosen order's Actions.Track to the live status.
        const chosen = orders[Math.min(a.index, orders.length - 1)];
        const trackPath = trackPathOf(chosen);
        if (!trackPath) {
          throw new Error(
            "Selected order has no Actions.Track path to follow for status.",
          );
        }
        const detail = await fetchDetailByPath(g, trackPath);
        const status = normalizeOrder(detail, {
          fetchedAt,
          source: "tracker-v2",
          phoneLast4: last4,
        });
        handles.push(
          await context.writeResource(
            "order-status",
            "order-status",
            status as unknown as Record<string, unknown>,
          ),
        );
        context.logger.info("Order stage: {stage} ({pct}%)", {
          stage: status.stage,
          pct: status.progressPct,
        });
        return { dataHandles: handles };
      },
    },
    "list-orders": {
      description:
        "List recent orders for a phone number (raw passthrough snapshot, no normalization)",
      arguments: ListOrdersArgs,
      execute: async (
        a: z.infer<typeof ListOrdersArgs>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const rawPhone = a.phone ?? g.phone;
        if (!rawPhone) throw new Error("No `phone` provided.");
        const phone = sanitizePhone(rawPhone);
        if (phone.length < 10) {
          throw new Error(
            `Phone must have 10 digits after sanitizing; got ${phone.length}.`,
          );
        }
        const last4 = phone.slice(-4);
        const orders = (await fetchByPhone(g, phone)).map((o) =>
          redactPhoneFields(o)
        );
        context.logger.info("Found {n} recent order(s) for ***-***-{l}", {
          n: orders.length,
          l: last4,
        });
        const handle = await context.writeResource("orders", "orders", {
          fetchedAt: nowIso(),
          phoneLast4: last4,
          count: orders.length,
          orders,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
