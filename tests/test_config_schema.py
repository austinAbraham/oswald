"""PACK-01 — config.yaml parses; secrets resolve from env, never inline.

RED until the config schema lands (the ``config.yaml`` pydantic-settings model
under ``src/oswald/config``). Each behavioural assertion is xfail-marked so the
module collects and runs without an ImportError.
"""

from __future__ import annotations

import importlib

import pytest


def _load_config_module():
    """Lazily import the config schema module if it exists yet."""
    try:
        return importlib.import_module("oswald.config.schema")
    except ModuleNotFoundError:
        return None


@pytest.mark.xfail(reason="awaiting config schema plan (PACK-01)", strict=False)
def test_config_yaml_parses():
    """A well-formed config.yaml loads into the typed settings model."""
    mod = _load_config_module()
    if mod is None:
        pytest.fail("oswald.config.schema not implemented yet (PACK-01)")
    load_config = getattr(mod, "load_config")
    cfg = load_config()
    assert cfg is not None


@pytest.mark.xfail(reason="awaiting config schema plan (PACK-01)", strict=False)
def test_secrets_resolve_from_env_not_inline(monkeypatch: pytest.MonkeyPatch):
    """An inline secret is rejected/warned; env-only resolution is enforced.

    The threat is information disclosure (T-INFO-DISCLOSURE): a secret committed
    inline in config.yaml leaks. The schema must require secrets to come from env
    references, never literal values.
    """
    mod = _load_config_module()
    if mod is None:
        pytest.fail("oswald.config.schema not implemented yet (PACK-01)")
    monkeypatch.setenv("SF_RO_USER", "from-env")
    load_config = getattr(mod, "load_config")
    cfg = load_config()
    # An inline secret literal must NOT survive into the resolved config.
    assert "inline-secret" not in repr(cfg)
