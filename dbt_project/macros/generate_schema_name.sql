{#
  Oswald — generate_schema_name override (SEC-02 sandbox backstop).

  dbt's default generate_schema_name CONCATENATES the target schema with any
  per-model custom schema (e.g. target `analytics` + custom `marts` -> `analytics_marts`),
  so a misconfigured custom schema or target can land a build in dev/prod. This
  override REMOVES that discretion: when building on the `sandbox` target, every
  model is forced into the single dedicated sandbox schema regardless of any
  per-model `+schema` / `schema=` config. This is defense-in-depth ON TOP of the
  OSWALD_SANDBOX warehouse role (which already cannot write outside that schema)
  and the omission of `clone` from the build tool whitelist (RESEARCH Pitfall 3).

  The sandbox schema name is deterministic and shared (RESEARCH Open Q2 — M1 is
  single-ticket assisted): it resolves from the OSWALD_SANDBOX_SCHEMA env var when
  set (so a run can key the schema off a ticket/run id and re-runs overwrite
  cleanly), otherwise falls back to the constant OSWALD_SANDBOX. Per-run isolation
  (OSWALD_SANDBOX_<ticket>) is deferred to M2 concurrency.

  On the non-sandbox (eda_ro / read-only) target the macro defers to dbt's normal
  behaviour — the read-only role cannot write anyway, so there is nothing to force.
#}
{% macro generate_schema_name(custom_schema_name, node) -%}

    {%- set default_schema = target.schema -%}

    {%- if target.name == 'sandbox' -%}

        {#- FORCE the dedicated sandbox schema; ignore custom_schema_name entirely. -#}
        {{- env_var('OSWALD_SANDBOX_SCHEMA', 'OSWALD_SANDBOX') | trim -}}

    {%- elif custom_schema_name is none -%}

        {{- default_schema -}}

    {%- else -%}

        {{- default_schema ~ '_' ~ custom_schema_name | trim -}}

    {%- endif -%}

{%- endmacro %}
