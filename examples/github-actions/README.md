# GitHub Actions recipes

Ready-made workflows for running Oswald headlessly in CI.

## `oswald-pipeline.yml` — draft-only pipeline on a sample ticket

Runs the full pipeline (`intake → clarify → context → eda → design → plan →
validate → pr → update-ticket`) against
[`examples/tickets/sample-retention-ticket.md`](../tickets/sample-retention-ticket.md)
with `--json` machine output (see
[docs/CLI.md, "CI / machine output"](../../docs/CLI.md#ci--machine-output---json)).

What it demonstrates:

- **Draft-only by construction.** No consent flag is ever passed, so Oswald's
  default-deny approval gate guarantees no comment is posted, no PR is opened,
  and no external write happens — CI gets drafts and evidence only.
- **One JSON step report per command on stdout**, saved under
  `oswald-step-reports/` and echoed into the job log.
- **Exit-code contract.** A hard error (`1`) fails its step; a **blocked**
  workflow (`2`) fails the `validate` step with an annotated `::error::`
  listing the blockers. On the sample ticket validation blocks by design
  (acceptance checks are deferred without a real dbt sandbox), so you can see
  the failure mode end-to-end.
- **`.oswald/` is uploaded as a build artifact** (`if: always()`) together with
  the step reports, so the evidence survives the failed job.

To use it in your project: copy the file into `.github/workflows/`, change the
trigger (`on:`), point intake at your real ticket source, and keep the
draft-only posture unless a human deliberately adds a consent flag.
