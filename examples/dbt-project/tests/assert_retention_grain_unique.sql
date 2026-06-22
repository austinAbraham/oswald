-- Singular test (dbt_utils-free): the declared grain of the retention mart —
-- one row per (customer_id, month) — must hold with no duplicate rows.
-- A passing test returns ZERO rows; any returned row is a grain violation.
select
    customer_id,
    month,
    count(*) as n_rows
from {{ ref('fct_customer_retention') }}
group by customer_id, month
having count(*) > 1
