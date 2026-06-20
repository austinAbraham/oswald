"""The ``oswald`` CLI surface for M1 (CLI-01 / CLI-02 / CLI-03).

Three commands, deliberately thin (D-10 — ``src/oswald`` is CLI-only in M1; the
assisted run IS the Claude Code skill, not a Pydantic-AI loop):

* ``oswald init``     — scaffold a starter ``config.yaml`` (from the shipped
  ``config.example.yaml``) plus an example *ready* ticket into a target dir,
  refusing to clobber an existing ``config.yaml`` without ``--force`` (CLI-01).
* ``oswald validate`` — a deterministic preflight that probes MCP connectivity,
  model-endpoint reachability + a structured-tool-call capability probe (D-08),
  and warehouse/repo access, failing with a SPECIFIC error that names the exact
  misconfiguration (CLI-02) and WARNing when branch protection is absent (SEC-03).
  No message ever echoes a secret value (threat T-05-01).
* ``oswald run``      — in M1 this does NOT start a service loop; it points the
  operator at the documented Claude Code skill entry ``/oswald-run <ticket-id>``
  (D-10 / CLI-03). The autonomous Pydantic-AI runtime arrives in M2.

The console-script ``oswald = "oswald.cli:app"`` (pyproject ``[project.scripts]``)
makes ``uv run oswald ...`` work.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import typer

app = typer.Typer(
    name="oswald",
    help="Open dbt Modeling Agent Harness — init / validate / run (M1).",
    no_args_is_help=True,
    add_completion=False,
)

# --------------------------------------------------------------------------- #
# Repo-root-relative source artifacts the CLI scaffolds from.
# src/oswald/cli.py → parents[2] is the repo root.
# --------------------------------------------------------------------------- #
_REPO_ROOT = Path(__file__).resolve().parents[2]
_EXAMPLE_CONFIG = _REPO_ROOT / "config.example.yaml"
_EXAMPLE_TICKET = _REPO_ROOT / "tests" / "fixtures" / "DEMO-1.md"

#: The documented Claude Code skill entry point the M1 ``run`` surface delegates
#: to (D-10). The skill itself (``.claude/skills/oswald-run/SKILL.md``) ships in
#: plan 06; ``run`` references it regardless.
RUN_SKILL_ENTRY = "/oswald-run"


# --------------------------------------------------------------------------- #
# init (CLI-01)
# --------------------------------------------------------------------------- #
@app.command()
def init(
    directory: Path = typer.Option(
        Path.cwd,
        "--dir",
        "-d",
        help="Target directory to scaffold into (defaults to the current dir).",
        file_okay=False,
        dir_okay=True,
    ),
    force: bool = typer.Option(
        False,
        "--force",
        "-f",
        help="Overwrite an existing config.yaml (off by default — init never clobbers).",
    ),
) -> None:
    """Scaffold a starter ``config.yaml`` + an example ready ticket (CLI-01).

    Copies the shipped ``config.example.yaml`` to ``<dir>/config.yaml`` and the
    example *ready* ticket to ``<dir>/tickets/DEMO-1.md``, then prints the created
    paths and a next-step hint. Refuses to overwrite an existing ``config.yaml``
    unless ``--force`` is given (idempotent, non-destructive by default).
    """
    target_dir = Path(directory)
    target_dir.mkdir(parents=True, exist_ok=True)

    config_dst = target_dir / "config.yaml"
    if config_dst.exists() and not force:
        typer.echo(
            f"Refusing to overwrite existing {config_dst} (pass --force to replace it).",
            err=True,
        )
        raise typer.Exit(code=1)

    if not _EXAMPLE_CONFIG.exists():  # pragma: no cover — shipped artifact
        typer.echo(f"Bundled template missing: {_EXAMPLE_CONFIG}", err=True)
        raise typer.Exit(code=1)
    shutil.copyfile(_EXAMPLE_CONFIG, config_dst)

    tickets_dir = target_dir / "tickets"
    tickets_dir.mkdir(parents=True, exist_ok=True)
    ticket_dst = tickets_dir / "DEMO-1.md"
    if _EXAMPLE_TICKET.exists():
        shutil.copyfile(_EXAMPLE_TICKET, ticket_dst)
    else:  # pragma: no cover — fall back to a minimal inline example ticket
        ticket_dst.write_text(_FALLBACK_TICKET, encoding="utf-8")

    typer.echo(f"Created {config_dst}")
    typer.echo(f"Created {ticket_dst}")
    typer.echo(
        "\nNext steps:\n"
        f"  1. Fill in the non-secret values in {config_dst} and export the "
        "referenced ${ENV} secrets (see config comments / docs/minimal-permissions.md).\n"
        "  2. Run `oswald validate` to preflight MCP / model / warehouse / repo access.\n"
        f"  3. Drive a ticket with the Claude Code skill: `{RUN_SKILL_ENTRY} DEMO-1`."
    )


# --------------------------------------------------------------------------- #
# validate (CLI-02 / D-08 / SEC-03) — fully wired in tasks 2 & 3
# --------------------------------------------------------------------------- #
@app.command()
def validate(
    config: Path = typer.Option(
        None,
        "--config",
        "-c",
        help="Path to config.yaml (defaults to the shipped example for a dry preflight).",
    ),
) -> None:
    """Deterministic preflight: MCP / model / warehouse / repo + capability probe.

    Aggregates every probe into a report; each FAIL names the exact
    misconfiguration (CLI-02) and no message echoes a secret. Branch-protection
    absence is a WARN, not a FAIL (SEC-03). Exits non-zero on any FAIL.
    """
    from oswald.preflight import ProbeReport
    from oswald.preflight.binding_probe import probe_binding
    from oswald.preflight.git_probe import probe_repo
    from oswald.preflight.mcp_probe import probe_servers
    from oswald.preflight.model_probe import probe_model, probe_model_residency

    cfg = _load_config_or_exit(config)

    report = ProbeReport()
    report.extend(probe_servers(cfg))
    report.add(probe_model(cfg))
    # MODE-01 / D-07: locked-down requires a self-hosted model endpoint; this FAILs
    # (operator-visible, drives a non-zero exit) when locked-down points at a public
    # off-boundary host. PASS under convenience (trust boundary documented).
    report.extend(probe_model_residency(cfg))
    report.extend(probe_repo(cfg))
    report.extend(probe_binding(cfg))

    _emit_report(report)

    if report.failed:
        raise typer.Exit(code=1)


# --------------------------------------------------------------------------- #
# run (CLI-03 / D-10) — points at the Claude Code skill; no service loop in M1
# --------------------------------------------------------------------------- #
@app.command()
def run(
    ticket_id: str = typer.Argument(
        None,
        help="The ready-ticket id to drive end-to-end (e.g. DEMO-1).",
    ),
) -> None:
    """Point the operator at the M1 Claude Code skill entry (CLI-03 / D-10).

    In M1 ``run`` does NOT start an autonomous loop — the assisted single-ticket
    run IS the ``oswald-run`` Claude Code skill. This command documents and prints
    the exact entry point; the Pydantic-AI service runtime is deferred to M2.
    """
    ticket = ticket_id or "<ticket-id>"
    typer.echo(
        "oswald run (M1): the assisted single-ticket run is a Claude Code skill, "
        "not a service loop (D-10).\n"
        f"\n  Invoke it in Claude Code:  {RUN_SKILL_ENTRY} {ticket}\n\n"
        "It drives intake → EDA → plan → model → build → PR, pausing at human "
        "gates. The autonomous Pydantic-AI runtime arrives in M2."
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _load_config_or_exit(config: Path | None):
    """Load + validate config, surfacing a SPECIFIC, secret-free error on failure."""
    from pydantic import ValidationError

    from oswald.config import load_config

    try:
        return load_config(config)
    except FileNotFoundError:
        typer.echo(
            f"config: file not found: {config or 'config.yaml'} "
            "(run `oswald init` to scaffold one).",
            err=True,
        )
        raise typer.Exit(code=1) from None
    except ValidationError as exc:
        # Pydantic error reprs name the offending field but never echo a resolved
        # secret value (EnvSecret rejects inline literals before they are stored).
        typer.echo(f"config: invalid configuration — {_first_validation_msg(exc)}", err=True)
        raise typer.Exit(code=1) from None


def _first_validation_msg(exc) -> str:
    """First field-named pydantic error, secret-free."""
    errors = exc.errors()
    if not errors:  # pragma: no cover
        return str(exc)
    first = errors[0]
    loc = ".".join(str(part) for part in first.get("loc", ())) or "<root>"
    return f"{loc}: {first.get('msg', 'invalid')}"


def _emit_report(report) -> None:
    """Print each check result; WARN/FAIL go to stderr so they stand out."""
    from oswald.preflight import CheckStatus

    for result in report.results:
        line = f"[{result.status.value}] {result.name}: {result.message}".rstrip(": ")
        is_problem = result.status is not CheckStatus.PASS
        typer.echo(line, err=is_problem)

    if report.failed:
        typer.echo("\nvalidate: FAILED — fix the misconfigurations above.", err=True)
    elif report.warned:
        typer.echo("\nvalidate: PASSED with warnings (see WARN lines above).")
    else:
        typer.echo("\nvalidate: PASSED — all preflight checks green.")


_FALLBACK_TICKET = """\
# DEMO-1 — Daily customer revenue mart

## Intent
Build a marts model reporting each customer's total order revenue per day.

## Grain
One row per customer per calendar day (`customer_id` + `order_date`).

## Source(s)
- `raw.orders` (`order_id`, `customer_id`, `order_date`, `amount`)
- `raw.customers` (`customer_id`, `customer_name`, `created_at`)

## Acceptance criteria
- One row per `customer_id` per `order_date`
- No null `customer_id` and no null `order_date`
- `daily_revenue` equals the sum of `raw.orders.amount` for that customer and day
"""
