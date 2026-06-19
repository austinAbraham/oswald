"""Oswald configuration package.

Houses the typed ``config.yaml`` schema (PACK-01). Secrets are resolved from the
environment via ``${ENV}`` references only — an inline literal credential in a
secret field is rejected with a named validation error (threat T-03-01).
"""

from oswald.config.schema import OswaldConfig, load_config

__all__ = ["OswaldConfig", "load_config"]
