-- geo-v3 acceptance check, independent of the TypeScript scoring code (docs/METHODOLOGY.md §6,
-- docs/meetings/2026-11-12-project-review-phased-plan.md, Phase 1). Read-only; run it on production with the
-- domain id and the window end substituted for :domain and :end (e.g. through `pnpm prod:sql` or the Supabase SQL
-- editor). src/services/geo-v3-check.int.test.ts proves it gives the numbers computeScores() writes for geo-v3.
--
-- Returns one row:
--   mention / recommendation: the rate as geo-v3 computes it (one weight per prompt × assistant cell, assistants
--   by reach with the 7-day phase-in, branded prompts and no-answers out, active topics only) and its 95 % interval
--   over prompts (linearised cluster variance, Student t for the number of prompts, Wilson on the effective n);
--   plain_prompt_mean: the unweighted mean over prompts of each prompt's mean over its assistants, the "SQL mean of
--   per-prompt rates" of the protocol; pooled: what answer-by-answer pooling gives (geo-v2's bias, for contrast);
--   bootstrap: the 95 % percentile interval of the mention rate over 1,000 resamples of prompts;
--   prompts, cells, answers.
with params as (select :domain::text as d, :end::timestamptz as e),
rows as (
  select m.provider_id as p, pv.prompt_id as q, (pv.category = 'BRAND_VALIDATION') as b,
         0.6 * pv.importance + 0.4 * pv.commercial_value as pw,
         coalesce((ms.signals ->> 'noAnswer')::boolean, false) as noans,
         coalesce((ms.signals ->> 'brandMentioned')::boolean, false) as named,
         (ms.signals ->> 'recommendationPosition') is not null as rec,
         m.finished_at::date as dday
  from params
  join measurements m on m.domain_id = params.d
  join measurement_signals ms on ms.measurement_id = m.id and ms.extractor_version = 'extract-v1'
  join prompt_versions pv on pv.id = m.prompt_version_id
  join prompts pr on pr.id = pv.prompt_id
  join topic_clusters tc on tc.domain_id = pr.domain_id and tc.key = pr.cluster_key and tc.active
  where m.status = 'SUCCEEDED' and m.finished_at >= params.e - interval '28 days' and m.finished_at <= params.e
    and m.configuration ->> 'role' = 'STANDARD'
),
prov as (
  select r.p,
         coalesce((d.provider_reach ->> r.p)::float, pv.reach) *
           least(1.0, greatest(1.0, extract(epoch from (params.e - (min(r.dday)::text || 'T00:00:00Z')::timestamptz)) / 86400.0) / 7.0) as eff
  from rows r join providers pv on pv.id = r.p join params on true join domains d on d.id = params.d
  group by r.p, d.provider_reach, pv.reach, params.e
),
share as (select p, eff / nullif(sum(eff) over (), 0) as s from prov),
cells as (
  select p, q, b, count(*) as answers, avg(pw) as meanpw from rows where not noans group by p, q, b
),
mass as (select p, sum(meanpw) as m from cells group by p),
w as (
  select r.q, r.named, r.rec, sh.s * c.meanpw / ms.m / c.answers as w
  from rows r
  join cells c on c.p = r.p and c.q = r.q and c.b = r.b
  join mass ms on ms.p = r.p
  join share sh on sh.p = r.p
  where not r.noans and not r.b
),
metric as (
  select 'mention' as k, q, w, named::int as y from w
  union all select 'recommendation', q, w, rec::int from w
),
v as (select k, sum(w * y) / sum(w) as value, sum(w) as sw, sum(w) ^ 2 / sum(w ^ 2) as answers_n from metric group by k),
per_prompt as (
  select mt.k, mt.q, sum(mt.w * (mt.y - v.value)) as res, sum(mt.w) as mass
  from metric mt join v on v.k = mt.k group by mt.k, mt.q
),
clus as (
  select pp.k, count(*) as g, sum(pp.mass) ^ 2 / sum(pp.mass ^ 2) as prompts_n, sum(pp.res ^ 2) as res2
  from per_prompt pp group by pp.k
),
tq as (
  select clus.*, case
    when clus.g - 1 between 1 and 30 then (array[12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
      2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052,
      2.048, 2.045, 2.042])[clus.g - 1]
    when clus.g - 1 <= 60 then 2.02 when clus.g - 1 <= 120 then 1.99 else 1.96 end as t
  from clus
),
neff as (
  select v.k, v.value, tq.g,
    case
      when tq.g < 2 or v.value <= 1e-9 or v.value >= 1 - 1e-9 then least(tq.prompts_n, v.answers_n)
      else greatest(1.0,
        (case when tq.res2 > 0
              then least(v.answers_n, v.value * (1 - v.value) / ((tq.g::float / (tq.g - 1)) * tq.res2 / (v.sw ^ 2)))
              else v.answers_n end) / (tq.t / 1.96) ^ 2)
    end as n
  from v join tq on tq.k = v.k
),
wilson as (
  select k, value, g, n,
    greatest(0.0, ((value + 1.96 ^ 2 / (2 * n)) - 1.96 * sqrt(value * (1 - value) / n + 1.96 ^ 2 / (4 * n * n))) / (1 + 1.96 ^ 2 / n)) as low,
    least(1.0, ((value + 1.96 ^ 2 / (2 * n)) + 1.96 * sqrt(value * (1 - value) / n + 1.96 ^ 2 / (4 * n * n))) / (1 + 1.96 ^ 2 / n)) as high
  from neff
),
plain as (
  select avg(prompt_rate) as plain_prompt_mean from (
    select q, avg(cell_rate) as prompt_rate from (
      select p, q, avg(named::int) as cell_rate from rows where not noans and not b group by p, q
    ) c group by q
  ) x
),
pooled as (select avg(named::int) as pooled from rows where not noans and not b),
-- Bootstrap over prompts (the protocol's reference for the interval): 1,000 resamples of the prompts with
-- replacement, cell weights kept, deterministic (hash, not random()) so a re-run gives the same interval.
prompt_sums as (
  select q, sum(w * named::int) as num, sum(w) as den, row_number() over (order by q) - 1 as i from w group by q
),
boot as (
  select b, sum(ps.num) / sum(ps.den) as rate
  from generate_series(1, 1000) b
  cross join generate_series(1, (select count(*)::int from prompt_sums)) j
  join prompt_sums ps on ps.i = abs(hashtext(b || ':' || j)) % (select count(*) from prompt_sums)
  group by b
)
select
  (select json_build_object('low', percentile_cont(0.025) within group (order by rate),
                            'high', percentile_cont(0.975) within group (order by rate)) from boot) as bootstrap,
  (select json_build_object('value', value, 'low', low, 'high', high, 'n', n) from wilson where k = 'mention') as mention,
  (select json_build_object('value', value, 'low', low, 'high', high, 'n', n) from wilson where k = 'recommendation') as recommendation,
  (select plain_prompt_mean::float8 from plain) as plain_prompt_mean,
  (select pooled::float8 from pooled) as pooled,
  (select g::int from wilson where k = 'mention') as prompts,
  (select count(*)::int from cells where not b) as cells,
  (select count(*)::int from rows where not noans and not b) as answers;
