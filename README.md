# @kneel/dominos

A read-only swamp behavior that tracks a Domino's pizza order through its
tracker stages, the same way the "Pizza Tracker" web widget does.

## What it does

Given the phone number an order was placed under (or a Store ID + Order Key),
it polls Domino's public guest-tracker API and persists a normalized
`order-status` snapshot with a canonical stage:

```
placed -> prep -> bake -> quality-check -> out-for-delivery | ready-for-pickup -> delivered -> complete
```

There is no authentication: the tracker endpoint is the unauthenticated,
phone-keyed service the guest tracker page uses. The phone number is PII, not a
secret, and is never persisted or logged in full — only as its last four
digits.

## Install

```bash
swamp extension pull @kneel/dominos
swamp behavior create @kneel/dominos pizza
```

## Configure

Set a default phone (recommended) or a Store ID + Order Key as global arguments
on the behavior:

```bash
swamp behavior create @kneel/dominos pizza --global-arg phone="(617) 555-1234"
```

## Use

```bash
# Track the most recent order on the configured phone
swamp behavior run pizza track

# Track a specific order by store + key
swamp behavior run pizza track --arg storeId=4337 --arg orderKey=abc-123

# Just list recent orders for a phone (raw passthrough)
swamp behavior run pizza list-orders --arg phone=6175551234
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

A `live`-labelled `tracker-reachable` check guards `track`: it verifies a
target is configured and the tracker host answers before running.

## Data

- `order-status` — normalized snapshot: `stage`, `stageLabel`, `progressPct`,
  `serviceMethod`, `timings`, `delivered`, plus the untouched upstream object
  under `raw`.
- `orders` — the raw list of recent orders from a phone lookup.

## Notes

Domino's upstream field shapes drift between releases, so the response schemas
are deliberately tolerant and the normalizer reads fields case-insensitively
with fallbacks. The stage mapping and normalization are built against the
documented / reverse-engineered tracker shapes; they should be spot-checked
against a live order the first time the tracker is pointed at a real order.
