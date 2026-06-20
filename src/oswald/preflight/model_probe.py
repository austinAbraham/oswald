"""Model-capability probe (D-08) — a structured-tool-call round-trip via LiteLLM.

Reachability alone is not enough: a model can answer ``ping`` yet be too weak to
produce the structured output the modeling skill depends on. This probe catches
"reachable but too weak" BEFORE a wasted end-to-end run (D-08, threat T-05-04) by
issuing ONE structured-tool-call request representative of the modeling skill's
*hardest* structured demand (RESEARCH Open Q4): return a well-formed **dbt-model
plan object** (model name + grain key + the two source refs + the join key) for a
SYNTHETIC trivial 2-source join.

Non-lenient (RESEARCH Assumption A4): the probe PASSES only if the model returns a
tool call whose arguments parse into the expected schema with all required fields
present and the two declared sources referenced. Anything short of that FAILs with
a specific ``"model capability floor not met: <what was missing>"`` message — never
a generic "failed" (CLI-02).

Data residency: the probe sends only a synthetic schema (two tiny made-up source
tables) — never warehouse data — so it stays inside the egress allowlist (threat
T-05-02). LiteLLM is invoked with telemetry off
(``turn_off_message_logging=True``, ``callbacks=[]``) so no prompt leaves the
boundary (CLAUDE.md §(c)).

Reusable floor-study hook: :func:`run_capability_probe` returns a structured
:class:`CapabilityProbeResult` for any (model, endpoint, api_key) triple, so the
empirical BYO-LLM floor study (D-07) can drive the same probe across candidate
models and record pass/fail for the published capability matrix.
"""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from oswald.preflight import CheckResult, CheckStatus

if TYPE_CHECKING:  # pragma: no cover
    from oswald.config import OswaldConfig

# --------------------------------------------------------------------------- #
# The synthetic trivial 2-source join the probe asks the model to plan.
# NO warehouse data — two made-up source tables only (threat T-05-02).
# --------------------------------------------------------------------------- #
SYNTHETIC_SOURCES: tuple[str, str] = ("raw.orders", "raw.customers")
SYNTHETIC_JOIN_KEY = "customer_id"

#: The tool the model MUST call — its parameter schema is the structured demand.
#: Mirrors the modeling skill's hardest structured output (a dbt-model plan).
PLAN_TOOL_NAME = "submit_dbt_model_plan"
PLAN_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": PLAN_TOOL_NAME,
        "description": (
            "Return a dbt model plan for a marts model joining two sources on a key."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "model_name": {
                    "type": "string",
                    "description": "snake_case dbt model name, e.g. fct_customer_orders",
                },
                "grain_keys": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Column(s) defining one row of the model's grain",
                },
                "sources": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The two source tables the model reads (schema.table)",
                },
                "join_key": {
                    "type": "string",
                    "description": "The column the two sources are joined on",
                },
            },
            "required": ["model_name", "grain_keys", "sources", "join_key"],
        },
    },
}

_REQUIRED_FIELDS = ("model_name", "grain_keys", "sources", "join_key")

_PROMPT = (
    "You are a dbt modeling assistant. Plan a single marts model that joins two "
    f"sources, {SYNTHETIC_SOURCES[0]} and {SYNTHETIC_SOURCES[1]}, on "
    f"'{SYNTHETIC_JOIN_KEY}'. Call {PLAN_TOOL_NAME} with the model name, grain "
    "key(s), the two source tables, and the join key. Do not write SQL; only "
    "return the plan via the tool call."
)


@dataclass(frozen=True)
class CapabilityProbeResult:
    """Structured outcome of one capability probe — the D-07 floor-study record.

    Attributes:
        passed: True iff the model returned a well-formed plan tool call.
        model: The model name probed (no secret).
        missing: What the structured output lacked (empty on pass) — drives the
            specific FAIL message.
        plan: The parsed plan arguments on success (synthetic; no warehouse data).
    """

    passed: bool
    model: str
    missing: str = ""
    plan: dict[str, Any] | None = None


def _extract_tool_call_args(response: Any) -> dict[str, Any] | None:
    """Pull the first tool-call arguments dict from a LiteLLM completion response.

    Returns ``None`` when the response carries no usable structured tool call —
    the signal of a too-weak model (it replied with prose, not a tool call).
    """
    try:
        message = response.choices[0].message
    except (AttributeError, IndexError, TypeError):
        return None
    tool_calls = getattr(message, "tool_calls", None)
    if not tool_calls:
        return None
    first = tool_calls[0]
    raw_args = getattr(getattr(first, "function", None), "arguments", None)
    if raw_args is None:
        return None
    if isinstance(raw_args, dict):
        return raw_args
    try:
        parsed = json.loads(raw_args)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _evaluate_plan(args: dict[str, Any]) -> str:
    """Return '' if the plan is well-formed, else a specific 'what was missing' string."""
    missing_fields = [f for f in _REQUIRED_FIELDS if not args.get(f)]
    if missing_fields:
        return "required plan fields missing: " + ", ".join(missing_fields)
    sources = args.get("sources")
    if not isinstance(sources, list) or len(sources) < 2:
        return "plan must reference both synthetic sources (got fewer than two)"
    referenced = {str(s).strip().lower() for s in sources}
    expected = {s.lower() for s in SYNTHETIC_SOURCES}
    if not expected.issubset(referenced):
        absent = sorted(expected - referenced)
        return "plan did not reference the declared source(s): " + ", ".join(absent)
    grain = args.get("grain_keys")
    if not isinstance(grain, list) or not grain:
        return "plan must declare at least one grain key"
    return ""


def run_capability_probe(
    *,
    model: str,
    endpoint: str | None = None,
    api_key: str | None = None,
    completion: Any = None,
) -> CapabilityProbeResult:
    """Drive ONE structured-tool-call probe against ``model``; return a floor-study record.

    This is the reusable hook the D-07 empirical-floor study calls per candidate
    model. ``completion`` is injectable so tests (and the floor study's recorded
    fixtures) supply a stubbed LiteLLM ``completion`` callable without a live call.
    """
    if completion is None:  # pragma: no cover — exercised live, mocked in tests
        import litellm

        completion = litellm.completion

    try:
        response = completion(
            model=model,
            api_base=endpoint,
            api_key=api_key,
            messages=[{"role": "user", "content": _PROMPT}],
            tools=[PLAN_TOOL_SCHEMA],
            tool_choice={"type": "function", "function": {"name": PLAN_TOOL_NAME}},
            temperature=0,
            # Data residency — keep telemetry off (CLAUDE.md §(c) / T-05-02).
            turn_off_message_logging=True,
        )
    except Exception as exc:  # noqa: BLE001 — categorise without leaking api_key
        return CapabilityProbeResult(
            passed=False,
            model=model,
            missing=f"model endpoint unreachable or rejected the request ({type(exc).__name__})",
        )

    args = _extract_tool_call_args(response)
    if args is None:
        return CapabilityProbeResult(
            passed=False,
            model=model,
            missing="model returned no structured tool call (prose only) — "
            "it cannot produce the structured dbt-model plan the modeling skill requires",
        )
    problem = _evaluate_plan(args)
    if problem:
        return CapabilityProbeResult(passed=False, model=model, missing=problem)
    return CapabilityProbeResult(passed=True, model=model, plan=args)


def probe_model(config: OswaldConfig, completion: Any = None) -> CheckResult:
    """Run the capability probe against the configured model; one named CheckResult.

    PASS iff the model returns a well-formed structured plan tool call. Otherwise
    FAIL with ``"model capability floor not met: <what was missing>"`` — specific,
    actionable, and secret-free (CLI-02). ``completion`` is injectable for tests.
    """
    result = run_capability_probe(
        model=config.model.name,
        endpoint=config.model.endpoint,
        api_key=config.model.api_key,
        completion=completion,
    )
    if result.passed:
        return CheckResult(
            name="model:capability",
            status=CheckStatus.PASS,
            message=(
                f"model '{config.model.name}' meets the capability floor "
                "(returned a well-formed dbt-model plan tool call)"
            ),
        )
    return CheckResult(
        name="model:capability",
        status=CheckStatus.FAIL,
        message=f"model capability floor not met: {result.missing}",
    )


# --------------------------------------------------------------------------- #
# locked-down model-residency probe (D-07 / MODE-01).
#
# Under ``locked-down`` the model endpoint MUST be a self-hosted / internal host —
# never a public, off-boundary provider endpoint — so prompts / EDA samples / ticket
# text never leave the user's boundary. Under ``convenience`` the trust boundary is
# documented, not enforced (the host may use a public model), so this probe is a
# PASS there. The probe is deterministic and offline (it inspects the configured
# endpoint string only — it never resolves DNS or makes a call), and it never echoes
# a secret (CLI-02 / T-05-01).
# --------------------------------------------------------------------------- #

#: Hostname suffixes that denote a self-hosted / internal endpoint (private DNS,
#: Kubernetes service DNS, RFC 6762 .local, common intranet conventions).
_INTERNAL_HOST_SUFFIXES: tuple[str, ...] = (
    ".internal",
    ".local",
    ".lan",
    ".intranet",
    ".svc",
    ".svc.cluster.local",
    ".cluster.local",
)

#: Known PUBLIC, off-boundary model-provider hosts — named explicitly so a
#: locked-down FAIL can say *why* the endpoint is off-boundary (clearer than a bare
#: "public host"). This is an aid to the message, NOT the classifier: any
#: publicly-routable host is rejected regardless of membership here.
_KNOWN_PUBLIC_MODEL_HOSTS: frozenset[str] = frozenset(
    {
        "api.anthropic.com",
        "api.openai.com",
        "api.mistral.ai",
        "api.cohere.ai",
        "api.groq.com",
        "generativelanguage.googleapis.com",
        "openrouter.ai",
    }
)


def _endpoint_host(endpoint: str) -> str:
    """Extract the bare hostname from a model endpoint URL (no scheme/port/path).

    Tolerates a bare ``host`` / ``host:port`` (no scheme) by retrying with a dummy
    scheme so ``urlsplit`` populates ``hostname`` instead of treating it as a path.
    """
    parsed = urlsplit(endpoint.strip())
    host = parsed.hostname
    if host is None:
        parsed = urlsplit(f"//{endpoint.strip()}")
        host = parsed.hostname
    return (host or "").lower()


def _labels(host: str) -> list[str]:
    """Split a hostname into its DNS labels, dropping a trailing root dot."""
    return [lbl for lbl in host.strip(".").split(".") if lbl]


def _embeds_public_domain(host: str) -> bool:
    """True iff ``host`` embeds a known public model domain as a label sequence.

    Exact LABEL-SEQUENCE matching (not substring): ``api.anthropic.com.evil.internal``
    embeds the labels ``[api, anthropic, com]`` and so is flagged, while a benign
    ``anthropic-mirror.internal`` (one label, no embedded public domain) is not. This
    is the WR-02 guard: a public domain buried as a deeper label of an
    attacker-registrable ``.internal``/``.local`` suffix must NOT be trusted as
    on-boundary just because the suffix matches.
    """
    host_labels = _labels(host)
    for public in _KNOWN_PUBLIC_MODEL_HOSTS:
        pub_labels = _labels(public)
        if not pub_labels:
            continue
        # Slide the public label sequence across the host labels (contiguous match).
        for start in range(len(host_labels) - len(pub_labels) + 1):
            if host_labels[start : start + len(pub_labels)] == pub_labels:
                return True
    return False


def _has_internal_suffix(host: str) -> bool:
    """True iff ``host`` ends in a recognized internal suffix on a LABEL boundary.

    ``str.endswith`` with dotted suffixes is already label-boundary-safe
    (``.internal`` matches ``vllm.internal`` but not ``notinternal``); kept as a
    named helper so the residency policy reads as exact-suffix matching, not a
    substring heuristic.
    """
    return host.endswith(_INTERNAL_HOST_SUFFIXES)


def _is_self_hosted_host(host: str) -> bool:
    """True iff ``host`` denotes a self-hosted / internal (on-boundary) endpoint.

    Conservative, residency-safe classification under locked-down. On-boundary ONLY
    if the host is one of:

    * ``localhost`` / a loopback / private (RFC1918) / link-local IP literal;
    * a bare SINGLE-LABEL hostname (no dot — an intranet short name);
    * a hostname ending in an explicitly-recognized internal suffix
      (:data:`_INTERNAL_HOST_SUFFIXES`), matched on a LABEL boundary.

    AND it must NOT embed a known public model domain as a label sequence — so
    ``api.anthropic.com.evil.internal`` (a public domain buried under an
    attacker-registrable ``.internal`` suffix) is FAILed, not trusted (WR-02).
    Anything else — a publicly-routable IP, a public registrable domain, or an
    internal-suffixed host that embeds a public domain — is off-boundary.
    """
    if not host:
        # An unparseable / empty host cannot be proven on-boundary — fail closed.
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        # An IP literal is self-hosted iff it is loopback / private / link-local.
        # (No DNS-name spoofing applies to a literal, so no embed check needed.)
        return ip.is_loopback or ip.is_private or ip.is_link_local
    if host == "localhost":
        return True
    # A spoofed host that buries a public model domain under an internal suffix or
    # short name must never be trusted as on-boundary (WR-02).
    if _embeds_public_domain(host):
        return False
    # A single-label hostname (no dot) is an intranet short name.
    if "." not in host:
        return True
    # Otherwise it must carry a recognized internal suffix (exact label boundary).
    return _has_internal_suffix(host)


def probe_model_residency(config: OswaldConfig) -> list[CheckResult]:
    """Assert the model endpoint is self-hosted under ``locked-down`` (D-07/MODE-01).

    Returns a list (composes with ``report.extend(...)`` like ``probe_servers`` /
    ``probe_binding``) carrying exactly one :class:`CheckResult`:

    * ``locked-down`` + a public / off-boundary endpoint → ``FAIL`` naming the
      endpoint host and the posture so the operator can act (CLI-02). It never
      echoes a secret — only the non-secret endpoint host appears.
    * ``locked-down`` + a self-hosted / internal endpoint → ``PASS``.
    * ``convenience`` → ``PASS`` (the trust boundary is documented, not enforced —
      the host may legitimately use a public model under convenience, D-07).

    Deterministic and offline: it inspects the configured endpoint string only.
    """
    posture = getattr(config, "posture", "convenience")
    host = _endpoint_host(config.model.endpoint)

    if posture != "locked-down":
        return [
            CheckResult(
                name="model:residency",
                status=CheckStatus.PASS,
                message=(
                    f"posture '{posture}': model endpoint residency is documented, "
                    "not enforced (the model host may be public under convenience)"
                ),
            )
        ]

    if _is_self_hosted_host(host):
        return [
            CheckResult(
                name="model:residency",
                status=CheckStatus.PASS,
                message=(
                    f"posture 'locked-down': model endpoint host '{host}' is "
                    "self-hosted/internal (on-boundary)"
                ),
            )
        ]

    public_note = (
        " (a known public model-provider endpoint)"
        if host in _KNOWN_PUBLIC_MODEL_HOSTS
        else ""
    )
    return [
        CheckResult(
            name="model:residency",
            status=CheckStatus.FAIL,
            message=(
                f"posture 'locked-down' requires a self-hosted model endpoint, but "
                f"'{host}'{public_note} is a public/off-boundary host — point "
                "model.endpoint at an internal/self-hosted endpoint (e.g. a local "
                "LiteLLM proxy, vLLM, or Ollama) so prompts/EDA/ticket text stay "
                "on-boundary"
            ),
        )
    ]


__all__ = [
    "probe_model",
    "probe_model_residency",
    "run_capability_probe",
    "CapabilityProbeResult",
    "PLAN_TOOL_SCHEMA",
    "PLAN_TOOL_NAME",
    "SYNTHETIC_SOURCES",
]
