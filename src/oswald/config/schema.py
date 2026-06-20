"""Typed ``config.yaml`` schema with env-only secret resolution (PACK-01).

One ``config.yaml`` declares everything pluggable — ``model``, ``mcp_servers``,
``requirement_source``, ``repo``, ``conventions``, ``gates`` and ``sandbox`` —
and is parsed into :class:`OswaldConfig`. The pack is runtime-agnostic (D-10):
the Claude Code skill consumes the same file in M1 that the M2 Pydantic-AI
service loads verbatim.

Security — threat T-03-01 (information disclosure via config secret fields):
secret-typed fields must reference an environment variable as ``${NAME}`` and
are resolved from :data:`os.environ` at load time. A value that is *not* an
``${ENV}`` reference (i.e. an inline literal credential) is rejected with a named
validation error — a secret is never silently stored inline. ``config.example.yaml``
ships only ``${ENV}`` placeholders.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
)

# ---------------------------------------------------------------------------
# Env-reference secret resolution (T-03-01)
# ---------------------------------------------------------------------------

#: Matches an entire ``${ENV_VAR}`` reference and captures the variable name.
_ENV_REF = re.compile(r"^\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)\}$")


class InlineSecretError(ValueError):
    """A secret field held an inline literal instead of an ``${ENV}`` reference.

    Raised (and surfaced by pydantic as a named validation error) when a value
    that looks like a literal credential is supplied where only an environment
    reference is permitted — the PACK-01 "secrets never stored inline" rule.
    """


def _resolve_secret(value: Any) -> str:
    """Resolve a secret field: require an ``${ENV}`` reference, read it from env.

    * ``${NAME}`` → the value of ``os.environ['NAME']`` (empty string if unset,
      so a missing env var is a deployment problem surfaced at use, not a parse
      crash on the shipped example template).
    * Any other non-empty string → :class:`InlineSecretError` (inline secret).
    """
    if not isinstance(value, str):
        raise InlineSecretError(
            "secret fields must be an ${ENV} reference, got a non-string value"
        )
    match = _ENV_REF.match(value.strip())
    if match is None:
        raise InlineSecretError(
            "secret must be an ${ENV} reference (e.g. ${SF_RO_USER}); "
            "inline literal credentials are never stored — set it in the "
            "environment and reference it instead"
        )
    return os.environ.get(match.group("name"), "")


#: A string field that MUST be supplied as an ``${ENV}`` reference and is
#: resolved from the environment. Inline literals are rejected with a named
#: error. Use for every credential/token/secret in the config.
EnvSecret = Annotated[str, BeforeValidator(_resolve_secret)]


# ---------------------------------------------------------------------------
# Nested config sections
# ---------------------------------------------------------------------------


class _Section(BaseModel):
    """Base for config sections: forbid unknown keys so typos fail loudly."""

    model_config = ConfigDict(extra="forbid")


class ModelConfig(_Section):
    """BYO-LLM model routing (LiteLLM).

    The model endpoint + name are non-secret; the API key is env-only. Telemetry
    is OFF by default (``callbacks: []``, ``turn_off_message_logging: true``) so
    no prompt/EDA/ticket text leaks off-boundary (threat T-03-02, RESEARCH
    Pitfall 1).
    """

    endpoint: str = Field(description="LiteLLM-compatible model endpoint base URL")
    name: str = Field(description="Model name as LiteLLM routes it, e.g. 'anthropic/claude-...'")
    api_key: EnvSecret = Field(description="Model API key — ${ENV} reference only")
    # Data-residency defaults — keep telemetry off (Pitfall 1 / T-03-02).
    callbacks: list[str] = Field(default_factory=list)
    turn_off_message_logging: bool = True


class McpServer(_Section):
    """A single MCP server registration (matches the .mcp.json shape, Pattern 3)."""

    command: str = Field(description="Executable to launch the MCP server, e.g. 'uvx'")
    args: list[str] = Field(default_factory=list)
    # Plain env passthrough for the server subprocess. Values may be ${ENV}
    # references the launcher resolves; modeled as free-form strings (the secret
    # discipline for warehouse/git creds is enforced where they are typed, e.g.
    # repo.bot_token, sandbox creds).
    env: dict[str, str] = Field(default_factory=dict)


class RequirementSource(_Section):
    """Where ready tickets come from (the ticketing MCP reference)."""

    kind: str = Field(description="Ticketing system kind, e.g. 'jira', 'github-issues'")
    mcp_server: str = Field(description="Name of the registered ticketing MCP server")


class RepoConfig(_Section):
    """Git remote + PR-only bot identity + the protected branch (SEC-03)."""

    remote: str = Field(description="Git remote URL the bot opens PRs against")
    bot_user: str = Field(description="Bot git identity (PR-only; cannot merge — SEC-03)")
    bot_token: EnvSecret = Field(description="Bot git token — ${ENV} reference only")
    protected_branch: str = Field(default="main", description="Branch the bot may never push to")


class ConventionsConfig(_Section):
    """Pointers to the shipped pack conventions (D-04/D-05)."""

    claude_md: str = Field(
        default="pack/CLAUDE.md",
        description="Path to the opinionated dbt house-style conventions",
    )
    sqlfluff: str = Field(
        default="pack/.sqlfluff",
        description="Path to the shipped Snowflake-dialect sqlfluff config",
    )


class GatesConfig(_Section):
    """Per-stage human approval gates. All ON in M1 (D-12)."""

    intake: bool = True
    plan: bool = True
    model: bool = True
    build: bool = True
    pr: bool = True


class SandboxConfig(_Section):
    """The dedicated sandbox schema dbt build/clone is restricted to (SEC-02)."""

    schema_name: str = Field(default="OSWALD_SANDBOX", description="Dedicated sandbox schema")
    target: str = Field(default="sandbox", description="dbt target name for the sandbox role")


# ---------------------------------------------------------------------------
# Connector binding (BIND-01 / MODE-01)
# ---------------------------------------------------------------------------

#: POSITIVE allowlist (WR-05): the known-local dbt-mcp server names the warehouse
#: role may bind to without an explicit ``local: true`` marker. The warehouse-data
#: path stays local (dbt-mcp) in BOTH postures (D-05/D-08). A name denylist of
#: hosted connectors was trivially evaded by aliasing a hosted Snowflake/dbt-Cloud
#: connector under a fresh ``mcp_servers`` key (``sf``/``wh``/``snow-prod``/…) — an
#: allowlist cannot be: any server not on it (and not explicitly marked local) is
#: rejected by default, fail-safe.
_LOCAL_WAREHOUSE_SERVERS: frozenset[str] = frozenset(
    {
        "dbt-eda",  # default local dbt-mcp EDA (read-only) server
        "dbt-build",  # local dbt-mcp build (sandbox-write) server
        "dbt-local",  # generic local dbt-mcp alias
        "dbt-mcp",  # bare local dbt-mcp launcher name
    }
)


class RoleBinding(_Section):
    """One logical role bound to an MCP server + a logical→actual tool-name map.

    The ``server`` is the MCP server (local like ``dbt-eda`` or a borrowed host
    connector like ``github``/``atlassian``) that provides this role. ``tool_map``
    captures cross-vendor renames (logical ``get_issue`` → actual ``getJiraIssue``);
    the install-mode prefix (``mcp__...`` vs ``mcp__plugin_oswald_...``) is handled
    by :mod:`oswald.binding.resolve`, never here.

    ``local`` is the explicit operator escape hatch for the warehouse residency
    allowlist (WR-05): set it to ``true`` to assert a non-default ``server`` name
    is a LOCAL dbt-mcp launcher (no remote URL, no ``DBT_HOST``/``DBT_TOKEN``).
    It is the operator's signed statement that the warehouse-data path stays
    on-boundary; it does NOT relax residency for a genuinely hosted connector.
    """

    server: str = Field(
        description="MCP server providing this role, e.g. 'dbt-eda'/'github'/'atlassian'"
    )
    tool_map: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "logical tool -> actual tool on the server "
            "(e.g. 'get_issue' -> 'getJiraIssue')"
        ),
    )
    local: bool = Field(
        default=False,
        description=(
            "Explicitly assert this server is a LOCAL (on-boundary) dbt-mcp "
            "launcher — the operator escape hatch for the warehouse residency "
            "allowlist (WR-05). Only set true for a real local stdio launcher."
        ),
    )


class BindingsConfig(_Section):
    """Per-role connector binding (BIND-01). Warehouse defaults to local dbt-mcp.

    The warehouse role ALWAYS defaults to the local ``dbt-eda`` server and may
    never be bound to anything but a KNOWN-LOCAL server (or one explicitly marked
    ``local: true``) — D-05/D-08 residency rule enforced at parse time via the
    POSITIVE allowlist in :meth:`_warehouse_stays_local`. ``ticketing`` and ``git``
    are optional borrowed-connector bindings.
    """

    profile: Literal["dbt-local", "github", "atlassian", "custom"] = "dbt-local"
    warehouse: RoleBinding = Field(default_factory=lambda: RoleBinding(server="dbt-eda"))
    ticketing: RoleBinding | None = None
    git: RoleBinding | None = None

    @field_validator("warehouse")
    @classmethod
    def _warehouse_stays_local(cls, value: RoleBinding) -> RoleBinding:
        """Require the warehouse role to bind to a KNOWN-LOCAL server (D-08, residency).

        POSITIVE allowlist (WR-05), not a name denylist: the warehouse-data path
        stays local in both postures, so the ``server`` must be one of the
        known-local dbt-mcp names (:data:`_LOCAL_WAREHOUSE_SERVERS`) OR be
        explicitly marked ``local: true`` by the operator. A hosted connector
        aliased under any other ``mcp_servers`` key (``sf``/``wh``/``snow-prod``/
        ``dbt-remote``/…) is rejected by default — it cannot evade the rule by
        renaming, which a denylist of seven hosted names could.
        """
        if value.local:
            # Operator explicitly asserts this is a local dbt-mcp launcher.
            return value
        if value.server not in _LOCAL_WAREHOUSE_SERVERS:
            allowed = ", ".join(sorted(_LOCAL_WAREHOUSE_SERVERS))
            raise ValueError(
                f"warehouse role must stay local (D-05/D-08): server {value.server!r} "
                f"is not a known-local dbt-mcp server (expected one of: {allowed}). "
                "Bind the warehouse to the local dbt-mcp server (e.g. 'dbt-eda'), or "
                "if this IS a local dbt-mcp launcher under a custom name, mark it "
                "explicitly with 'local: true'. Schema/EDA data never egresses "
                "off-boundary — a hosted connector under any alias is rejected."
            )
        return value


# ---------------------------------------------------------------------------
# Top-level config
# ---------------------------------------------------------------------------


class OswaldConfig(_Section):
    """The whole ``config.yaml``: everything pluggable in one typed model (PACK-01).

    A missing required section raises a typed, named pydantic ``ValidationError``
    pointing at the absent field.
    """

    model: ModelConfig
    mcp_servers: dict[str, McpServer]
    requirement_source: RequirementSource
    repo: RepoConfig
    conventions: ConventionsConfig = Field(default_factory=ConventionsConfig)
    gates: GatesConfig = Field(default_factory=GatesConfig)
    sandbox: SandboxConfig = Field(default_factory=SandboxConfig)
    # Posture (MODE-01 / D-07): convenience = host/hosted peripheral connectors +
    # host model allowed (trust boundary documented, not air-gapped); locked-down =
    # local servers + self-hosted model + the egress-allowlist invariant enforced.
    # The warehouse-data path stays local in BOTH postures (D-08).
    posture: Literal["convenience", "locked-down"] = "convenience"
    bindings: BindingsConfig = Field(default_factory=BindingsConfig)

    @field_validator("mcp_servers")
    @classmethod
    def _at_least_one_server(cls, value: dict[str, McpServer]) -> dict[str, McpServer]:
        if not value:
            raise ValueError("mcp_servers must declare at least one MCP server")
        return value


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

#: Repo root — three parents up from this file (src/oswald/config/schema.py).
_REPO_ROOT = Path(__file__).resolve().parents[3]
#: Default config the loader reads when no explicit path is given. The shipped
#: example carries only ${ENV} placeholders, so it parses cleanly with secrets
#: resolved from the environment.
DEFAULT_CONFIG_PATH = _REPO_ROOT / "config.example.yaml"


def load_config(path: str | os.PathLike[str] | None = None) -> OswaldConfig:
    """Load and validate a ``config.yaml`` into :class:`OswaldConfig`.

    Args:
        path: Config file to read. Defaults to the shipped ``config.example.yaml``
            at the repo root (copy-and-fill template).

    Secrets (``${ENV}`` references) resolve from :data:`os.environ` during
    validation; an inline literal secret raises a named validation error.
    """
    config_path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    return OswaldConfig.model_validate(raw)
