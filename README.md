# @kneel/dominos

A read-only swamp behavior that tracks a Domino's pizza order through its
tracker stages, the same way the "Pizza Tracker" web widget does.

## What it does

Given the phone number an order was placed under (or a Store ID + Order Key),
it polls Domino's public `tracker-presentation-service` (v2 JSON) and persists a
normalized `order-status` snapshot with a canonical stage:

```
placed -> prep -> bake -> quality-check -> out-for-delivery | ready-for-pickup -> delivered -> complete
```

The phone lookup returns only order "directory" records (an `Actions.Track`
path, no status); the live status comes from a second call to that path. The
service needs `dpz-market` / `dpz-language` headers (set from the `market` /
`language` global args, default `UNITED_STATES` / `en`) or it answers 400 —
there is no auth token. The phone number is PII, not a secret, and is never
persisted or logged in full (not even inside the `raw` passthrough) — only as
its last four digits.

## Install

```bash
swamp extension pull @kneel/dominos
swamp behavior create @kneel/dominos pizza
```

## Configure

Set a default phone (recommended) or a Store ID + Order Key as global arguments
on the behavior:

```bash
swamp behavior create @kneel/dominos pizza --global-arg phone="<10-digit-phone>"
```

## Use

```bash
# Track the most recent order on the configured phone
swamp behavior run pizza track

# Track a specific order by store + key
swamp behavior run pizza track --input storeId=4337 --input orderKey=abc-123

# Just list recent orders for a phone (raw passthrough)
swamp behavior run pizza list-orders --input phone=<10-digit-phone>
```

Read the result:

```bash
swamp data query 'behavior("pizza") && name == "order-status"' --select content
```

## Methods

| Method        | Purpose                                                              |
| ------------- | -------------------------------------------------------------------- |
| `track`       | Fetch + persist the current tracker status for one order             |
| `list-orders` | List recent orders for a phone (raw snapshot, no normalization)      |

A `live`-labelled `tracker-reachable` check guards `track`: it verifies the
tracker host answers before running.

## Reports

Both run automatically after `track` and read the latest `order-status`:

| Report                        | Shows                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `@kneel/dominos-status-card`  | "Where's my pizza" card: stage + progress bar, ETA, store, items     |
| `@kneel/dominos-order-journey`| Per-stage timeline with durations, total time, and the store's ETA   |

```bash
swamp report get @kneel/dominos-status-card   --model pizza --markdown
swamp report get @kneel/dominos-order-journey  --model pizza --markdown
```

The journey is reconstructed from a single snapshot — Domino's returns
`StartTime`, the make duration, and the oven/rack marks in one payload, so no
repeated polling is needed.

## Data

- `order-status` — normalized snapshot: `stage`, `stageLabel`, `progressPct`,
  `serviceMethod`, `timings`, `delivered`, plus the untouched upstream object
  under `raw`.
- `orders` — the raw list of recent orders from a phone lookup.

## Notes

Domino's upstream field shapes drift between releases, so the response schemas
are deliberately tolerant and the normalizer reads fields case-insensitively
with fallbacks. The stage mapping and normalization were verified end-to-end
against a live US carry-out order on 2026-10-31 (both the phone and
store+order-key paths). Non-US markets (e.g. Canada) use a different, classic
XML endpoint that this extension does not implement.
