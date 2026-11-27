# GY-4041: core's events table stops growing after GY-4005

GY-4005 (merged 2026-11-27T11:14Z) deletes unread `agent-registry.*` rows older than 7 days and stops
the registry writing whole documents. After a Postgres `DELETE`, the freed space is reused, not given
back: the table only shrinks after `VACUUM FULL`. GY-4005 runs that once a catch-up frees 1 GB. So the
outcome to check is that the table **stops growing**, not that it shrinks.

## Check (manual:post-deploy/events-table-stops-growing)

On core, read `resources.database.tables` → `events` bytes from `/healthz` twice, at least 24 hours
apart, both after GY-4005 deployed. Write down both readings with their UTC times below.

```sh
date -u +%FT%TZ; curl -s "$GRAPHYARD_URL/healthz" | jq '.resources.database.tables'
```

**Pass:** growth between the two readings is under 1% of the table (about 94 MB at 9.38 GB).
A drop also passes: that means the `VACUUM FULL` rewrite ran.
**Fail:** name the writer that is still adding events, with its kind and rate (rows and bytes per day), from
the read-only by-kind query in `reports/gy-4005-events-by-kind.md`, limited to `created_at > now() - interval '1 day'`.

## Readings

| UTC time            | events bytes | source |
|---------------------|--------------|--------|
| 2026-11-27T11:56Z   | 9.3769 GB    | core `/healthz` (GY-4041 summary) |
| 2026-11-27T14:25Z   | 9.3840 GB    | core `/healthz` (GY-4041 summary) |
| ≥ 2026-11-28T11:56Z | _pending_    | post-deploy reading, 24 h after the first |

Early rate: +7.1 MB in 2.5 h, about 69 MB a day, or 0.73% of the table. If it holds, the 24-hour
growth is under the 1% bound. The reading 24 hours later decides.
