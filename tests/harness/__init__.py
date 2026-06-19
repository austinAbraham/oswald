"""Headless scripted-harness package (populated in the Walking-Skeleton plan).

In plan 01-02 this package is intentionally EMPTY of feature code — only this
marker exists so ``tests.harness`` is importable. The Walking-Skeleton plan adds
``tests/harness/harness.py`` exposing ``run_one_ticket(ticket_id)``, which the
``scripted_harness`` conftest fixture imports lazily.

Per D-10 the M1 headless harness lives under ``tests/harness/``, NOT under
``src/oswald/`` (the M1 ``oswald`` CLI is ``init``/``validate`` only). The
egress-allowlist test (SEC-04 / D-11) exercises this harness, not the
interactive Claude Code session.
"""
