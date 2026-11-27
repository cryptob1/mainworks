# GY-4005: core's events table by kind

Measured 2026-11-27 ~11:00Z on core (`/healthz`: database 10.0 GB of a 10.7 GB default bound, `events` 9.37 GB).

## How it was measured

The worker cannot reach core's Postgres: the host credential files are masked from it. So this is a read-only
sample through `GET /api/events` (`routine=include`, `payload=full`): 100 pages of 100 rows spread evenly over seq
1..4,324,351. Each page is weighted by the seq span it covered, which accounts for rows compaction already removed.
It records counts and payload byte lengths only. No payload value was kept or printed.

Read the numbers with two caveats:
- `bytes` is uncompressed JSON. Postgres stores large payloads compressed (TOAST).
- Item rows saved as a delta come back from the API with the whole work document filled in (`resolvedPayloadSql`),
  so item kinds (github.observed, heartbeat, merge-writer.*, evidence…) are upper bounds. Registry rows store the
  whole registry document on every row, so their sizes are what is stored, before compression.

## Top ten kinds (estimated rows, uncompressed bytes, share of sampled bytes)

| kind | rows | bytes | avg | share |
|---|---|---|---|---|
| github.observed | 521,094 | 30.71 GB | 59 KB | 52.5% |
| github.queue | 46,177 | 3.67 GB | 80 KB | 6.3% |
| heartbeat | 108,306 | 3.62 GB | 33 KB | 6.2% |
| merge-writer.trial-step | 72,850 | 2.78 GB | 38 KB | 4.8% |
| agent-registry.selected | 23,485 | 2.29 GB | 98 KB | 3.9% |
| evidence | 9,002 | 1.31 GB | 146 KB | 2.2% |
| action.completed | 13,670 | 1.29 GB | 94 KB | 2.2% |
| agent-registry.session-ended | 11,064 | 1.12 GB | 101 KB | 1.9% |
| agent-registry.observed | 7,318 | 1.11 GB | 151 KB | 1.9% |
| agent-registry.sessions-settled | 7,708 | 0.97 GB | 126 KB | 1.7% |

The last hour (10:00–11:00Z, 5,267 rows) wrote 141 registry rows. Each held the whole registry, about 92 KB.

## What this change does about it

- Registry events now carry only the change, the fields it touched and the revision. The document lives in its
  own `agent_registry` row. A read never writes, so `sessions-settled` is no longer appended.
- `agent-registry.observed`, `session-ended` and `sessions-settled` are deleted after 7 days. No src read selects
  them by name, and the only family-wide reads take the newest rows. This is about 26,000 rows of whole documents,
  roughly 3 GB uncompressed. The deletes run in batches of 1,000 on the pool, every 10 minutes. Item history is
  never touched: those rows have a work id.
- When a catch-up frees 1 GB, the events table is rewritten once (`VACUUM FULL`) so its size drops. Events
  writes wait while the rewrite runs.
- `agent-registry.selected` is kept: `src/agent-registry.ts` reads it for 14 days.

## Next fixes (not in this change)

- github.observed, heartbeat and merge-writer.trial-step are item kinds and the biggest writers by count.
  Compaction already removes routine rows after 14 days. Their stored size needs the exact query below.

## Post-deploy check (manual:post-deploy/events-table-shrinks)

On core's host, read-only, on the day after deploy and the day before:

```sql
SET default_transaction_read_only = on;
SELECT pg_total_relation_size('events');
SELECT kind, count(*), sum(pg_column_size(payload)) AS bytes FROM events GROUP BY kind ORDER BY bytes DESC LIMIT 10;
```

Or read `resources.database.tables` on `/healthz`.
