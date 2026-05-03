# Perf harness

Phase 9 performance + memory-leak harness. All scripts boot the same Fastify app the e2e suite uses (Drizzle + Redis), seed a single test account, and drive load via [`autocannon`](https://github.com/mcollina/autocannon).

## Scenarios

| script              | targets                  | duration      | what it tells you                                                                                             |
| ------------------- | ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `perf/sustained.ts` | 100 RPS mixed read/write | 5 min default | does the API hold a sustained load with no degradation? p50/p95/p99 latency, error rate.                      |
| `perf/burst.ts`     | 1000 RPS GET-heavy       | 60 s default  | does the API survive a burst? p99/p99.9 latency may degrade but no 5xx leaks.                                 |
| `perf/soak.ts`      | 30 RPS mixed             | 1 h default   | memory-leak detector. RSS / heap / fd snapshotted every 60 s; first-quarter avg vs last-quarter avg compared. |

## Running

```bash
# Bring up infra
docker compose up -d

# Choose a scenario
npx tsx perf/sustained.ts            # 5 min @ 100 RPS
npx tsx perf/sustained.ts --duration 30   # short smoke (30 s)
npx tsx perf/burst.ts                # 60 s @ 1000 RPS
npx tsx perf/soak.ts                 # 1 h @ 30 RPS
npx tsx perf/soak.ts --duration 60   # short smoke (60 s)
```

Each script prints a JSON summary at the end and exits non-zero if its pass criteria are violated.

## Pass criteria (initial; revisable)

- **Sustained 100 RPS:** p99 < 250 ms, error rate (excluding 429) = 0.
- **Burst 1000 RPS:** no 5xx, p99 may degrade to 1 s.
- **Soak 1 h @ 30 RPS:** no metric > 1.5× its first-quarter average, no 5xx.

## What's NOT measured

- Real WebKit driver latency — Phase 9 still runs the mock driver. Real-driver perf is a Phase-after-Phase-9 question once the WebKit fork ships.
- Multi-instance Redis cluster behaviour — single-instance Redis is what Phase 9 exercises.
- Postgres replication lag, etc. — single-instance Postgres.
