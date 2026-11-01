# Changelog

## 2026.10.31.1

Initial release. Read-only Domino's pizza-tracker behavior, verified end-to-end
against a live US order:

- `track` — fetch + persist a normalized `order-status` snapshot by phone or by
  Store ID + Order Key. Uses the `tracker-presentation-service` v2 JSON API:
  the phone lookup returns order directory records, and the live status is read
  from a second call to each order's `Actions.Track` path. Requires
  `dpz-market` / `dpz-language` headers (set from `market` / `language` global
  args). Normalizes to a canonical stage (`placed` -> `prep` -> `bake` ->
  `quality-check` -> `out-for-delivery` | `ready-for-pickup` -> `delivered` ->
  `complete`), with progress %, service method, timings, estimated wait, and a
  `raw` passthrough.
- `list-orders` — raw recent-orders snapshot (directory records) for a phone.
- Reports (run after `track`): `@kneel/dominos-status-card` ("where's my pizza"
  card with progress bar + items) and `@kneel/dominos-order-journey` (per-stage
  timeline with durations, total time, and the store's ETA, reconstructed from
  a single snapshot's timing fields).
- `tracker-reachable` live check guards `track` (reachability only; target
  validation lives in the method, which can see per-call args).
- Phone numbers are PII: never persisted or logged in full, only as last-4 —
  including inside the `raw` passthrough (redactPhoneFields).
