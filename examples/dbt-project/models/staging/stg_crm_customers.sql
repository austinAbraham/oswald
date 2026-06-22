-- Staging: customer master from CRM.
-- Renames/casts only. Flags internal + test accounts so the mart can exclude
-- them per AE-1234 (employees, QA seed data, sandbox customers).
with source as (
    select * from {{ ref('raw_crm_customers') }}
)

select
    cast(customer_id as integer)               as customer_id,
    lower(acquisition_channel)                 as acquisition_channel,
    lower(account_type)                        as account_type,
    account_type in ('internal', 'test')       as is_internal_or_test,
    created_month                              as created_month
from source
