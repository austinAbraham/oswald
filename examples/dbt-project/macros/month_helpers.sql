{#
  Small, dbt_utils-free helpers for arithmetic on 'YYYY-MM' month strings.
  Implemented against DuckDB date functions. Kept local so the example has zero
  package dependencies (no `dbt deps` step required).
#}

{# Whole months between two 'YYYY-MM' strings (b - a). #}
{% macro months_between(a, b) %}
    (
        (date_part('year', strptime({{ b }} || '-01', '%Y-%m-%d'))
         - date_part('year', strptime({{ a }} || '-01', '%Y-%m-%d'))) * 12
        + (date_part('month', strptime({{ b }} || '-01', '%Y-%m-%d'))
           - date_part('month', strptime({{ a }} || '-01', '%Y-%m-%d')))
    )
{% endmacro %}

{# The month after a 'YYYY-MM' string, returned as 'YYYY-MM'. #}
{% macro next_month(m) %}
    strftime(
        strptime({{ m }} || '-01', '%Y-%m-%d') + interval 1 month,
        '%Y-%m'
    )
{% endmacro %}
