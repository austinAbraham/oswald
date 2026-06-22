-- AE-1234: Monthly customer retention mart.
--
-- Grain: one row per (customer_id, month). Internal + test accounts are
-- EXCLUDED. Each row carries the customer's acquisition channel and a
-- retention_status in {new, retained, reactivated, churned}.
--
-- "active" in a month := had activity events (>0) OR a paying subscription.
-- A churned row is emitted for the month AFTER a customer's last active month
-- (so churn is observable at the customer+month grain).

with customers as (

    select *
    from {{ ref('stg_crm_customers') }}
    where not is_internal_or_test          -- exclude internal/test accounts

),

activity as (
    select customer_id, activity_month as month, event_count
    from {{ ref('stg_events_customer_activity') }}
),

billing as (
    select customer_id, billing_month as month, is_paying
    from {{ ref('stg_billing_subscriptions') }}
),

-- Union all customer-month signals into one calendar of observed months.
observed_months as (
    select customer_id, month from activity
    union
    select customer_id, month from billing
),

monthly as (

    select
        c.customer_id,
        om.month,
        c.acquisition_channel,
        coalesce(a.event_count, 0)        as event_count,
        coalesce(b.is_paying, false)      as is_paying,
        (coalesce(a.event_count, 0) > 0 or coalesce(b.is_paying, false)) as is_active
    from customers c
    join observed_months om
        on om.customer_id = c.customer_id
    left join activity a
        on a.customer_id = om.customer_id and a.month = om.month
    left join billing b
        on b.customer_id = om.customer_id and b.month = om.month

),

active_only as (
    select * from monthly where is_active
),

with_history as (

    select
        customer_id,
        month,
        acquisition_channel,
        event_count,
        is_paying,
        row_number() over (partition by customer_id order by month) as active_rank,
        lag(month) over (partition by customer_id order by month)   as prev_active_month,
        lead(month) over (partition by customer_id order by month)  as next_active_month,
        max(month) over (partition by customer_id)                  as last_active_month
    from active_only

),

-- Each active month, classified.
active_rows as (

    select
        customer_id,
        month,
        acquisition_channel,
        case
            when active_rank = 1 then 'new'
            -- consecutive months (prev month immediately precedes) → retained
            when prev_active_month is not null
                 and {{ months_between('prev_active_month', 'month') }} = 1
                then 'retained'
            else 'reactivated'
        end as retention_status,
        true as is_active
    from with_history

),

-- One churned row per customer, in the month AFTER their last active month.
churn_rows as (

    select
        customer_id,
        {{ next_month('last_active_month') }} as month,
        acquisition_channel,
        'churned' as retention_status,
        false as is_active
    from (
        select distinct customer_id, acquisition_channel, last_active_month
        from with_history
    ) t

)

select customer_id, month, acquisition_channel, retention_status, is_active
from active_rows

union all

select customer_id, month, acquisition_channel, retention_status, is_active
from churn_rows
