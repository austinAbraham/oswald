-- Staging: monthly subscription/billing signal.
with source as (
    select * from {{ ref('raw_billing_subscriptions') }}
)

select
    cast(customer_id as integer)   as customer_id,
    billing_month                  as billing_month,
    cast(is_paying as boolean)     as is_paying
from source
