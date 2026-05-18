-- Arc 1 sub-slice 6.1 (v2-#6 bundled-LLM opt-in).
--
-- Founder verdicts locked 2026-05-18:
--   Q1=B (no trial), Q2=skip, Q3=C ($20 default monthly cap), Q4=A
--   (BYOK-always-wins; bundled-LLM only when BYOK absent/expired),
--   Q5=A (hide actual upstream cost — posted at a flat per-turn rate).
--
-- Two new columns on `accounts`:
--
--   bundled_llm_consent BOOLEAN NOT NULL DEFAULT FALSE
--     Customer opt-in flag. FALSE on every existing row at migrate
--     time (no implicit consent). The signup-flow + self-service
--     endpoint (sub-slices 6.2 + 6.6) flip this; until then, every
--     customer is opt-out.
--
--   bundled_llm_monthly_cap_usd_cents INTEGER NOT NULL DEFAULT 2000
--     Soft-cap (Q3=C) on bundled-LLM spend per calendar month. 2000
--     = $20 default. Sub-slice 6.6 lets customers raise / lower via
--     PATCH /v1/account/me/bundled-llm-settings; range is $0-$10,000
--     (0..1_000_000 cents) enforced at route layer. Soft-cap means
--     when sum(usage_records.cost_usd_cents) for source
--     'agent_decomposer_bundled' >= cap, agent-session turns refuse
--     with BundledLlmBudgetExhaustedError (sub-slice 6.5) until the
--     next calendar month.
--
-- Backward-compat: NULL → DEFAULT means existing rows pick up
-- consent=false + cap=$20 transparently. No backfill needed.

ALTER TABLE "accounts"
  ADD COLUMN "bundled_llm_consent" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "bundled_llm_monthly_cap_usd_cents" INTEGER NOT NULL DEFAULT 2000
    CHECK ("bundled_llm_monthly_cap_usd_cents" >= 0 AND "bundled_llm_monthly_cap_usd_cents" <= 1000000);
