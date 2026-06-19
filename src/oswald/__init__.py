"""Oswald — Open dbt Modeling Agent Harness.

The ``oswald`` CLI (``init`` / ``validate`` / ``run``, per decision D-10) lives in
:mod:`oswald.cli`; the console script is wired as ``oswald = "oswald.cli:app"``.
``src/oswald`` is CLI-only in M1 — the assisted run IS the Claude Code skill, and
the Pydantic-AI service runtime is deferred to M2.
"""

from __future__ import annotations


def main() -> None:
    """Backwards-compatible entry point — delegates to the Typer app."""
    from oswald.cli import app

    app()
