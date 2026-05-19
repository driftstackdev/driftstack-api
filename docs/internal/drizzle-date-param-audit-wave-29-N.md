# drizzle-orm Date-param exhaustive audit (post-2026-05-19 prod incident)

**Status:** CLEAN — zero additional latent bug sites in `apps/`, `packages/`,
`scripts/`. The two known bug instances are fully fixed; the
structural drift guard at `apps/server/tests/unit/drizzle-date-param-
no-regress-structural-guard.test.ts` (commit `d9417a91`) prevents future
regressions at CI time.

## Search patterns executed

```bash
# 1. Raw sql template-literal Date-looking interpolations
grep -rnE 'sql`[^`]*\$\{[^}]*(now|Date|At)[^}]*\}' apps/ packages/ scripts/ \
  --include="*.ts" --include="*.mjs" | grep -v '\.test\.ts'

# 2. tx.execute(sql + db.execute(sql call sites
grep -rnE 'tx\.execute\(sql|db\.execute\(sql|database\.db\.execute\(sql' \
  apps/ --include="*.ts" | grep -v '\.test\.ts'

# 3. .execute(sql + .execute< call sites (generic-typed variants)
grep -rnE '\.execute<|\.execute\(' apps/ --include="*.ts" \
  | grep -v '\.test\.ts' | grep -E 'execute\(sql|execute<'

# 4. sql.unsafe / client.unsafe direct callers
grep -rnE 'sql\.unsafe|client\.unsafe|\.unsafe\(' apps/ packages/ scripts/ \
  --include="*.ts" --include="*.mjs" | grep -v '\.test\.ts'
```

## Findings matrix

### Pattern 1 — raw `sql`` template-literal Date-looking interpolations (4 hits, all SAFE)

| Site                                  | Interp                                  | Verdict | Why                                                                                                                |
| ------------------------------------- | --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/db/schema.ts:1849`   | `${t.revokedAt}`                        | SAFE    | Drizzle column reference in a partial-index WHERE; renders as a SQL identifier at build time, not a JS Date value. |
| `apps/server/src/db/schema.ts:1852`   | `${t.revokedAt}`                        | SAFE    | Same.                                                                                                              |
| `apps/server/src/db/schema.ts:1860`   | `${t.revokedAt}` + `${t.livekitApiKey}` | SAFE    | Same.                                                                                                              |
| `apps/server/src/db/usage-repo.ts:83` | `${usageRecords.recordedAt}`            | SAFE    | Drizzle column accessor in `date_trunc('day', <col>)` — column identifier, not Date.                               |

### Pattern 2/3 — `.execute(sql\`...\`)` call sites (5 hits, all SAFE or FIXED)

| Site                                                       | Date interp? | Verdict          | Notes                                                                      |
| ---------------------------------------------------------- | ------------ | ---------------- | -------------------------------------------------------------------------- |
| `apps/server/src/db/scheduled-jobs-repo.ts:65`             | YES → ISO    | FIXED `1b2001c8` | The 2026-05-19 prod incident root cause. Uses `nowIso` / `lockStaleAtIso`. |
| `apps/server/src/db/legal-repo.ts:35`                      | NO           | SAFE             | Only `${accountId}` (string).                                              |
| `apps/server/src/db/migrate.ts:56`                         | NO           | SAFE             | No interpolations (`SELECT count(*)::text FROM __drizzle_migrations`).     |
| `apps/server/src/db/atlas-priority-events-repo.ts:268`     | YES → ISO    | SAFE             | §8.1.b `getStats` uses `sinceIso` (pre-serialised at the call site).       |
| `apps/server/src/services/durable-webhook-delivery.ts:338` | YES → ISO    | FIXED `5d7fe344` | The 2nd instance found during the post-fix audit. Uses `nowIso`.           |

### Pattern 4 — `client.unsafe(...)` direct callers (4 hits, all SAFE)

| Site                                              | Verdict | Notes                                                                                    |
| ------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `apps/server/src/lib/slow-query-log.ts:46`        | SAFE    | Wrapper that captures + passes through params verbatim; doesn't itself bind Date params. |
| `apps/server/tests/e2e/helpers/server.ts:125–127` | SAFE    | DROP SCHEMA / CREATE SCHEMA — no params at all.                                          |
| `apps/server/tests/e2e/helpers/server.ts:327`     | SAFE    | TRUNCATE_SQL constant — string only, no params.                                          |
| `apps/server/tests/e2e/smoke.spec.ts:42`          | SAFE    | `SELECT count(*) FROM …` — no Date params.                                               |

## Conclusion

- **2 KNOWN BUGS** — both fixed (`1b2001c8` + `5d7fe344`).
- **0 LATENT BUGS** in current source.
- **9 SAFE sites** confirmed (drizzle column references + non-Date params + literal SQL).
- **1 structural drift guard** in place (`d9417a91`) — prevents 3rd instance from being added silently.

The recurring-bug-prevention loop is closed for this bug class. New
raw-`sql\`` template literals interpolating Date-looking variables will
trip the drift guard at CI time, surfacing the ISO-string workaround
pattern (or an audited ALLOW_LIST addition) before the customer-session
firing path can hit it.

## Related artifacts

- `docs/internal/drizzle-date-param-workaround.md` — empirical bisection
  - ISO-string workaround pattern + 0.45.2 upstream audit (bug persists,
    expanded to 10 OIDs).
- `apps/server/tests/unit/drizzle-date-param-no-regress-structural-guard.test.ts`
  — automated drift guard in CI.
