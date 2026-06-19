"""CLI-01 — `oswald init` scaffolds config.yaml + example ticket.

RED until the Typer CLI lands under ``src/oswald``; xfail-marked so the module
collects and runs without an ImportError. Uses Typer's ``CliRunner``.
"""

from __future__ import annotations

import importlib

import pytest


def _load_cli():
    try:
        module = importlib.import_module("oswald.cli")
    except ModuleNotFoundError:
        return None
    return getattr(module, "app", None)


@pytest.mark.xfail(reason="awaiting init CLI plan (CLI-01)", strict=False)
def test_init_scaffolds_config_and_example_ticket(tmp_path):
    """`oswald init` writes a starter config.yaml and an example ticket."""
    app = _load_cli()
    if app is None:
        pytest.fail("oswald.cli not implemented yet (CLI-01)")
    from typer.testing import CliRunner

    result = CliRunner().invoke(app, ["init", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert (tmp_path / "config.yaml").exists()
    # An example ready ticket is scaffolded alongside the config.
    assert any(p.suffix == ".md" for p in tmp_path.rglob("*.md"))
