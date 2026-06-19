"""Root pytest configuration.

The test *scaffold* (fixtures, the egress-allowlist harness, contract tests) lands in
plan 02 under ``tests/``. This root ``conftest.py`` carries only collection-level
configuration that must exist from the first slice — it contains NO tests.

``pytest_sessionfinish`` maps pytest's "no tests collected" status (exit code 5 in
pytest >= 9) to success (exit code 0). Until plan 02 ships the test modules, an empty
suite is the expected, non-error state: collection must succeed and not error, but
finding zero tests is acceptable scaffolding behavior.
"""

import pytest


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Treat an empty (no-tests-collected) suite as success, not failure.

    pytest returns EXIT_NOTESTSCOLLECTED (5) when no tests are found. While the test
    scaffold is deferred to plan 02 this is the expected state, so we normalize it to
    EXIT_OK (0). Once real tests exist this branch is inert. Genuine collection errors
    (exit codes 2/3/4) are left untouched and still fail the run.
    """
    if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:
        session.exitstatus = pytest.ExitCode.OK
