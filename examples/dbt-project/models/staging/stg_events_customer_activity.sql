-- Staging: per-customer monthly activity events.
with source as (
    select * from {{ ref('raw_events_customer_activity') }}
)

select
    cast(customer_id as integer)   as customer_id,
    activity_month                 as activity_month,
    cast(event_count as integer)   as event_count
from source
