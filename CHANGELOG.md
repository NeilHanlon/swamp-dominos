# Changelog

## 2026.10.31.1

Initial release. Read-only Domino's pizza-tracker behavior:

- `track` — fetch + persist a normalized `order-status` snapshot by phone
  (tracker-v2 JSON) or by Store ID + Order Key (legacy XML), with a canonical
  stage (`placed` -> `prep` -> `bake` -> `quality-check` ->
  `out-for-delivery` | `ready-for-pickup` -> `delivered` -> `complete`),
  coarse progress percentage, timings, and a `raw` passthrough.
- `list-orders` — raw recent-orders snapshot for a phone number.
- `tracker-reachable` live check guarding `track`.
- Phone numbers are PII: never persisted or logged in full, only as last-4.
