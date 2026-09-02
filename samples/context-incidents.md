# Incident log

- 2025-09-08: Partner API returned 5xx errors for nine consecutive days. Reseller
  orders in the West region did not sync to the order system. Root cause was an
  expired certificate on the partner gateway.
- 2025-09-22: Warehouse stocktake in Central. No customer impact.
- 2025-07-15: Checkout latency regression, rolled back same day.

# Release notes

## 2025-09
- Shipped new Partner onboarding flow behind a flag. Not enabled for West.
- Deprecated the legacy pricing endpoint.

## 2025-08
- Retail promotional campaign ran through the month across all regions.

# Roadmap

- Rebuild the reseller sync pipeline. No date committed.
- Expand into the Nordics.
