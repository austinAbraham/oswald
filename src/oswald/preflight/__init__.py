"""Deterministic preflight probes for ``oswald validate`` (D-08 / CLI-02).

``validate`` is a *deterministic* CLI step (not an LLM call): it confirms the
configured MCP servers, model endpoint, warehouse role and git/repo identity are
reachable and correctly scoped BEFORE a (possibly expensive) end-to-end run, and
it runs a structured-tool-call **capability probe** to catch a model that is
reachable but too weak (D-08). Every failure names the exact misconfiguration
(CLI-02) and no probe ever echoes a secret value (threat T-05-01).

The probes are split by surface so each is independently mockable in tests:

* :mod:`oswald.preflight.mcp_probe`   — raw ``mcp`` SDK connect + ``list_tools``
  per configured server (MCP-01 reachability).
* :mod:`oswald.preflight.model_probe` — a single LiteLLM structured-tool-call
  round-trip that asks the model to return a dbt-model plan object for a trivial
  2-source join — representative of the modeling skill's hardest structured
  demand, NOT a trivial ping (D-08).
* :mod:`oswald.preflight.git_probe`   — bot PR-capability + a branch-protection
  check that WARNs (not fails) when protection is absent (SEC-03).

The shared result vocabulary (:class:`CheckStatus`, :class:`CheckResult`) lets
``cli.validate`` aggregate every probe into one report and derive the exit code
(non-zero on any FAIL; a WARN never fails the run).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class CheckStatus(str, Enum):
    """Outcome of a single preflight check.

    * ``PASS`` — the surface is reachable and correctly configured.
    * ``WARN`` — a non-fatal gap the operator should see but that does not block
      a run (e.g. absent branch protection, SEC-03 gray area).
    * ``FAIL`` — a misconfiguration that must be fixed before a run; the message
      names the exact component and cause (CLI-02).
    """

    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"


@dataclass(frozen=True)
class CheckResult:
    """One named preflight check outcome.

    Attributes:
        name: Stable check identifier, e.g. ``"mcp:dbt-eda"`` or ``"model:capability"``.
        status: :class:`CheckStatus`.
        message: Human-readable, **secret-free** detail. On a FAIL this MUST name
            the exact misconfiguration (the server, role, grant, or capability)
            so the operator can act without guessing (CLI-02). On a PASS/WARN it
            summarises what was checked.
    """

    name: str
    status: CheckStatus
    message: str = ""

    @property
    def ok(self) -> bool:
        """True unless this check is a hard FAIL (a WARN is still ``ok``)."""
        return self.status is not CheckStatus.FAIL


@dataclass
class ProbeReport:
    """Aggregate of every preflight :class:`CheckResult` for one ``validate`` run."""

    results: list[CheckResult] = field(default_factory=list)

    def add(self, result: CheckResult) -> None:
        self.results.append(result)

    def extend(self, results: list[CheckResult]) -> None:
        self.results.extend(results)

    @property
    def failed(self) -> bool:
        """True if any check is a hard FAIL — drives a non-zero exit code."""
        return any(r.status is CheckStatus.FAIL for r in self.results)

    @property
    def warned(self) -> bool:
        return any(r.status is CheckStatus.WARN for r in self.results)


__all__ = ["CheckStatus", "CheckResult", "ProbeReport"]
