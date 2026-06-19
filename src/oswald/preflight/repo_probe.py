"""Plan-named alias for the repo/warehouse preflight checks.

The plan artifact spec lists ``src/oswald/preflight/repo_probe.py``; the test
scaffold (``tests/test_git_identity.py``) imports ``oswald.preflight.git_probe``
and asserts ``check_branch_protection``. The checks live in :mod:`git_probe`
(the test-authoritative name); this module re-exports them so the plan's named
artifact path also resolves and neither contract drifts.
"""

from __future__ import annotations

from oswald.preflight.git_probe import (
    check_branch_protection,
    check_pr_capability,
    check_warehouse_access,
    probe_repo,
)

__all__ = [
    "check_branch_protection",
    "check_pr_capability",
    "check_warehouse_access",
    "probe_repo",
]
