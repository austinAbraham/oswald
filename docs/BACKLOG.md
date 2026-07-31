# Candidate feature backlog

Ranked output of a structured feature-ideation pass (2026-07-31): five ideation
lenses over the codebase, consolidated and scored 1-10 by a three-persona judge
panel (daily practitioner / enterprise data lead / OSS maintainer). Scores are
averaged. This is a menu, not a commitment — see [ROADMAP.md](./ROADMAP.md) for
what is actually planned.

| # | Feature | Category | Score | Effort | Status |
|---|---------|----------|-------|--------|--------|
| 1 | oswald run <ticket> --auto — single-command pipeline driver with enforced transitions | Autonomous Pipeline Execution | 9 | M | PR #3 |
| 2 | Real git RepoProvider + multi-forge PR (gh, glab, Azure DevOps) | Distribution & Delivery Integrations | 9 | M | PR #4 |
| 3 | Persistent audit ledger (.oswald/audit.jsonl) with tamper-evident hash chain and compliance export | Approvals, Policy & Audit | 8.3 | M | PR #2 |
| 4 | Provider resolution report + --strict-providers | Developer Experience & Observability | 8.3 | S | PR #1 |
| 5 | Autonomy policy levels: policies.autonomy with per-action auto-approve allowlist | Approvals, Policy & Audit | 8 | M | PR #5 |
| 6 | oswald review — deterministic dbt code-review tentacle with sqlfluff lint backend | Quality Gates & Review | 8 | L | idea |
| 7 | Read-only data-diff / reconciliation runner (sandbox vs prod) | Quality Gates & Review | 8 | L | idea |
| 8 | oswald resume — first-class recovery from blocked, with bounded auto-retry | Autonomous Pipeline Execution | 7.7 | M | in progress |
| 9 | Content-addressed async approval queue (oswald approvals / oswald approve <id>) | Approvals, Policy & Audit | 7.7 | L | extends roadmap |
| 10 | Cross-ticket knowledge base (org glossary + decision-log mining) | Host-Agent Intelligence & Organizational Learning | 7.7 | L | idea |
| 11 | CI/headless mode: --json step reports + GitHub Actions recipe | Autonomous Pipeline Execution | 7.3 | S | in progress |
| 12 | Ticket readiness gate with auto-drafted clarification requests | Quality Gates & Review | 7.3 | M | in progress |
| 13 | dbt test coverage scorer (finally enforce require_tests_for_new_models) | Quality Gates & Review | 7.3 | M | idea |
| 14 | Checkpoints, rollback, and oswald diff over artifact history | Autonomous Pipeline Execution | 7 | M | idea |
| 15 | oswald status — at-a-glance run dashboard | Developer Experience & Observability | 7 | S | in progress |
| 16 | Host-LLM review layer via runtime adapters (oswald-review slash command) | Host-Agent Intelligence & Organizational Learning | 7 | M | extends roadmap |
| 17 | Baseline snapshots + regression detection in validate | Quality Gates & Review | 6.7 | M | idea |
| 18 | Artifact drift checker (stale upstream detection) | Quality Gates & Review | 6.7 | S | in progress |
| 19 | dbt Semantic Layer / Cube artifact emission with metric-collision check | Data Platform Integrations | 6.7 | M | extends roadmap |
| 20 | Team conventions block (naming, layout, test defaults) | Developer Experience & Observability | 6.7 | L | idea |
| 21 | Shareable policy packs (versioned per-team presets) | Approvals, Policy & Audit | 6.3 | M | extends roadmap |
| 22 | Oswald MCP server (oswald mcp-serve): expose the pipeline as tools to any host | Distribution & Delivery Integrations | 6.3 | L | idea |
| 23 | oswald reconcile — one-shot background reconciler for parked runs | Autonomous Pipeline Execution | 6 | L | idea |
| 24 | Run & phase telemetry ledger (runs.jsonl / transitions.jsonl) + oswald stats and status --timeline | Developer Experience & Observability | 6 | M | idea |
| 25 | Explain/teach mode: next --explain + global --explain onboarding cards | Developer Experience & Observability | 6 | S | idea |
| 26 | Adversarial reviewer agent (analyst + skeptic pair) | Host-Agent Intelligence & Organizational Learning | 6 | M | idea |
| 27 | Data-quality bridge: Elementary / Great Expectations | Data Platform Integrations | 5.7 | M | idea |
| 28 | Orchestrator freshness probe (Airflow / Dagster, read-only) | Data Platform Integrations | 5.7 | M | idea |
| 29 | oswald doctor --fix | Developer Experience & Observability | 5.7 | M | idea |
| 30 | Batch mode: oswald run --batch over a ticket queue with per-ticket state namespaces | Autonomous Pipeline Execution | 5.3 | L | extends roadmap |
| 31 | Multi-warehouse CLI driver family: DuckDB first, then BigQuery / Postgres / Redshift / Databricks | Data Platform Integrations | 5.3 | L | idea |
| 32 | oswald view — local read-only web viewer over .oswald | Developer Experience & Observability | 5.3 | L | extends roadmap |
| 33 | Interactive init wizard + shell completions | Developer Experience & Observability | 5.3 | M | idea |
| 34 | LLM-judge completeness scoring via a JudgmentProvider seam | Host-Agent Intelligence & Organizational Learning | 5.3 | M | extends roadmap |
| 35 | Stakeholder brief generator (oswald brief) | Host-Agent Intelligence & Organizational Learning | 5.3 | S | idea |
| 36 | CLI-first ticket providers: GitHub Issues (gh) and Linear | Distribution & Delivery Integrations | 5 | M | extends roadmap |
| 37 | Golden-ticket eval harness for tentacle quality (oswald eval) | Host-Agent Intelligence & Organizational Learning | 5 | M | idea |
| 38 | dbt Cloud validation backend | Data Platform Integrations | 4.7 | M | extends roadmap |
| 39 | Ticket estimation from past runs | Host-Agent Intelligence & Organizational Learning | 4 | M | idea |
| 40 | SQLMesh project support (plan/build/validate) | Data Platform Integrations | 3.3 | L | idea |

## Details by category

### Autonomous Pipeline Execution

**oswald run <ticket> --auto — single-command pipeline driver with enforced transitions** — score 9, effort M — *PR #3*

A `run` command that loops the dispatch logic `next --run` already has: read state.status.phase, dispatch recommendNextCommand via program.parseAsync, repeat until a terminal phase, exit-2 block, or an approval gate. Default is fully draft-safe — auto mode never synthesizes consent flags, so ApprovalService denies all 8 write classes and the run parks at the first gate with a clear 'awaiting approval for <action>' message. Bundles the prerequisite hardening: advanceWorkflow finally enforces canTransition (which exists in states.ts but is never checked today), so a buggy tentacle can no longer skip validate or un-ship a ticket and an unattended loop can only move along audited state-machine edges.

- *Why:* Engineers and host agents (e.g. a /oswald-run slash command) get intake→validate in one invocation instead of ten while default-deny is untouched — auto mode removes keystrokes between already-safe steps, never grants consent. Natural entry point for cron/CI, and the transition guard makes the state machine actually a machine rather than a convention, the non-negotiable correctness baseline for any unattended chaining.
- *Builds on:* src/cli/commands/next.ts (--run dispatch pattern, program.parseAsync), src/core/workflow/states.ts (recommendNextCommand, LINEAR_NEXT, canTransition — currently unenforced), src/tentacles/base.ts advanceWorkflow (:317), src/cli/commands/_run.ts RunOutcome exit-code contract (0/1/2), existing workflow unit tests.

**oswald resume — first-class recovery from blocked, with bounded auto-retry** — score 7.7, effort M — *in progress*

COMMAND_FOR_STATE maps blocked→null, so `next` dead-ends even though canTransition explicitly allows blocked→any non-terminal state. `oswald resume` reads state.status.blockers, re-runs the check that blocked (usually validate, per _run.ts's own hint), and on pass transitions back to a persisted blocked_from phase added to the state schema. In --auto, a policy-capped retry count (autonomy.max_resume_attempts) applies before parking for a human.

- *Why:* Users stop hand-editing state.yml or guessing which command un-blocks; auto mode gets the standard 'human fixed the TODO(human) scaffold, machine re-verifies and continues' pattern. The offline demo that deliberately dead-ends at validate --skip-external becomes resumable once real dbt is available.
- *Builds on:* src/core/workflow/states.ts blocked→non-terminal edge in canTransition (legal but unreachable via CLI today), src/core/state/schema.ts status block (add blocked_from), src/cli/commands/next.ts terminal-phase handling.

**CI/headless mode: --json step reports + GitHub Actions recipe** — score 7.3, effort S — *in progress*

A --json output mode that serializes what runTentacleCommand already computes structurally (RunOutcome: exitCode, artifactsWritten, nextCommand, plus phase, blockers, warnings, open questions, approval decisions) as one JSON document per step via the existing injectable Logger seam. Ships a documented GitHub Actions workflow: on ticket-labeled issue or schedule, run `oswald run <ticket> --auto` draft-only, upload .oswald/ artifacts, fail the job on exit 2 so blocked state is visible in CI.

- *Why:* Makes Oswald scriptable by anything — CI, cron, the reconciler, other agents — without scraping log lines. The CLI is already non-interactive and fail-closed (no yes means denied), so CI mode is almost free; the 0/1/2 exit-code contract was designed for exactly this and is currently unexploited.
- *Builds on:* src/cli/commands/_run.ts RunOutcome + standard output block, src/core/logging Logger injection (tests already swap it), documented exit codes 0/1/2.

**Checkpoints, rollback, and oswald diff over artifact history** — score 7, effort M

Hook the single ArtifactManager.write choke point (plus state.yml) to snapshot per step/run into .oswald/history/<run-id>/ (copy-on-write, reusing compact.ts's archive mechanics), with bounded retention. `oswald rollback [--to <phase>]` restores the last good checkpoint and re-points state via legal transitions; `oswald diff [artifact|phase]` shows what changed between the last two runs of a phase — e.g. how metric_spec.yml or the plan's changed-files manifest moved after a re-run with better ticket text. Auto runs record which checkpoint each step started from in the audit ledger.

- *Why:* Makes unattended runs reversible — a bad EDA profile or mis-parsed design rewinds to the last good phase instead of nuking .oswald — and fixes the silent-overwrite problem in the normal re-run loop (intake → clarify → re-intake), where today the previous artifact and the record of what a clarification changed are destroyed. Rollback confidence is what lets teams raise autonomy levels; diffs make iteration visible and auditable.
- *Builds on:* ArtifactManager.write/append (src/core/artifacts/manager.ts) as the single artifact IO choke point, canonical names (src/core/artifacts/names.ts), src/core/state/store.ts (side-effect-free writeState, injected clock), compact.ts archive-directory pattern, canTransition resume edge.

**oswald reconcile — one-shot background reconciler for parked runs** — score 6, effort L

A cron/CI-friendly idempotent command that scans all parked or blocked runs (per-ticket namespaces from batch mode), re-checks whether each gate condition cleared — consumed approval tokens, clarification answers detected via TicketProvider.getTicket/searchRelated, human-edited TODO(human) scaffolds now passing dbt parse, validate now green — advances whatever the autonomy policy permits, and emits a summary of what moved, what is still waiting, and on whom. One-shot by design (no daemon): safe under cron, launchd, or a scheduled GitHub Action.

- *Why:* Closes the loop on async human input: the analyst answers a Jira question Tuesday night, Wednesday's 7am reconcile notices, resumes context→eda, and parks again at the next gate — with every advancement recorded in the audit ledger. This is the engine the roadmap's Slack/Teams notification channel would report from.
- *Builds on:* Depends on run --auto, resume, approval queue, and batch-mode namespaces. Seams: state.status.phase/blockers, provider interfaces in src/tools/providers/types.ts (TicketProvider read methods — mocks today, real MCP later), dbt runner in src/tools/dbt/ for re-validation, audit ledger for reporting.

**Batch mode: oswald run --batch over a ticket queue with per-ticket state namespaces** — score 5.3, effort L

Sequential multi-ticket processing: `oswald run --batch` over ticket files or ids drives each ticket with the --auto loop until its first human gate or terminal state, archives that ticket's state.yml + artifacts into a per-ticket namespace (.oswald/tickets/<id>/), then starts the next. `oswald queue status` lists each parked run and the exact gate it awaits. Deliberately sequential — state.yml is a single-ticket store today — with the namespacing as the honest first step toward multi-ticket concurrency.

- *Why:* A team lead points Oswald at Monday's ticket pile and gets back N parked runs each sitting at a clarify/approve/build gate, instead of running the pipeline N times by hand. The namespaced state layout is reusable groundwork for true concurrency later.
- *Builds on:* run --auto loop, src/core/state/store.ts artifactDir parameter (readState/updateState already take a configurable artifact_dir — the seam for per-ticket roots), intake --from-file path, compact.ts archival mechanics.

### Distribution & Delivery Integrations

**Real git RepoProvider + multi-forge PR (gh, glab, Azure DevOps)** — score 9, effort M — *PR #4*

Replace MockRepoProvider with a real local-git provider (currentBranch/changedFiles/createBranch/commit via the git CLI) plus pluggable forge backends for openPullRequest: `gh pr create` for GitHub, `glab mr create` for GitLab, `az repos pr create` for Azure DevOps, selected by remote-URL detection. The GitHub leg overlaps the planned GitHub MCP client; the local-git layer and GitLab/Azure DevOps support are the novel parts.

- *Why:* Today `oswald pr` drafts against a mock, so nothing ever reaches a forge — the single biggest 'it's all drafts' friction the docs admit. GitLab and Azure DevOps matter disproportionately for the enterprise analytical-engineering teams Oswald targets (many are not on GitHub). Forge CLIs follow the snow-CLI credential model: auth owned by gh/glab/az.
- *Builds on:* RepoProvider interface (src/tools/providers/types.ts:173) with write-gated createBranch/commit/openPullRequest already routing through ApprovalService action classes and the absolute prohibit on direct_push_to_protected_branch — the gates exist, only the provider is missing.

**Oswald MCP server (oswald mcp-serve): expose the pipeline as tools to any host** — score 6.3, effort L

A new `oswald mcp-serve` entrypoint publishing the 15 CLI verbs as MCP tools (oswald_intake, oswald_eda, oswald_next...) and .oswald/ artifacts + state.yml as MCP resources, via @modelcontextprotocol/sdk over stdio — inverting the roadmap's Model A (Oswald as MCP client) into Oswald-as-server. Safety carries over: tool inputs map to resolveConsent flags, write tools require an explicit approve:true argument so the host's own approval UI becomes the human gate, and draft-equivalent stays the default.

- *Why:* Removes the per-runtime adapter tax (src/runtimes/adapters/ hand-renders prompts for claude-code/codex/gemini-cli/cursor/windsurf) and makes Oswald installable in one line in any MCP host — Claude Desktop, Cursor, Windsurf, VS Code Copilot, custom agents. The highest-leverage distribution move for an 'MCP-native' project that today has no MCP surface at all.
- *Builds on:* next.ts already dispatches verbs programmatically via program.parseAsync; runTentacleCommand is a clean invoke seam; tool schemas map 1:1 to Commander options; the adapters' MCP-SETUP.md docs become real instructions.

**CLI-first ticket providers: GitHub Issues (gh) and Linear** — score 5, effort M

Real TicketProvider implementations that need no MCP client: GhIssueTicketProvider using `gh issue view/comment --json` and a LinearTicketProvider over Linear's GraphQL API (token via env-var reference). getTicket/searchRelated are read paths; postComment stays gated behind the ticket_update action class.

- *Why:* Many small analytics teams track work in GitHub Issues or Linear, not Jira; this makes intake/clarify/update-ticket real for them long before the Model A MCP client lands, using the same zero-credential CLI trick already proven with snow and gh. GitHub extends the roadmap's MCP item with a CLI path; Linear is a new target.
- *Builds on:* TicketProvider interface (src/tools/providers/types.ts) + selectProviders wiring; binary detection copies src/tools/snowflake/detect.ts; ticket bodies pass through ExternalContentSanitizer.wrap exactly as intake already does for mock tickets; clarify's approval-gated postComment finally has a live target.

### Approvals, Policy & Audit

**Persistent audit ledger (.oswald/audit.jsonl) with tamper-evident hash chain and compliance export** — score 8.3, effort M — *PR #2*

Append-only JSONL written from the choke points everything already flows through: every ApprovalService decision (action class, allow/deny/prohibit, consent source — flag vs policy vs approval token — reason, ticket id, artifact content hashes, rolling hash chain for tamper evidence), every step outcome from runTentacleCommand (command, phase before/after, exit code, artifacts), every SQL statement validated or executed, every provider fallback (snowflake→mock), and every redaction/sanitizer hit — all stamped by the injected clock. `oswald audit export` bundles to CSV/JSON for SOX / model-governance / data-governance review. Also closes a documented inconsistency: docs/CLI.md advertises .oswald/audit.log as a canonical artifact while docs/ASSUMPTIONS.md admits the trail is console-only.

- *Why:* Non-negotiable for auto mode — when nobody watched the run, the ledger is the only answer to 'what did Oswald auto-approve and why'. Regulated teams (finance, credit — exactly Oswald's likely early adopters) cannot deploy an agent workflow without demonstrable approval trails, and denied/prohibited decisions currently vanish when the terminal scrolls. It is also the data layer the roadmapped audit UI needs, so building it now is pure prerequisite work, and it closes a stale-docs bug.
- *Builds on:* ApprovalService.decide/requireApproval as the single gate covering all 8 action classes (src/core/approvals/service.ts), runTentacleCommand standard output block (src/cli/commands/_run.ts buildContext as the wire-up point), SqlSafetyValidator + SnowflakeWarehouseProvider for SQL events, ArtifactManager.append with injected Clock, ARTIFACT_FILES registry for hashing; resolves the CLI.md vs ASSUMPTIONS.md discrepancy.

**Autonomy policy levels: policies.autonomy with per-action auto-approve allowlist** — score 8, effort M — *PR #5*

Add an autonomy block to PoliciesConfigSchema (level: draft_only | auto_safe | auto_approved, plus auto_approve: [create_branch, commit] using the existing action vocabulary/aliases). ApprovalService.requireApproval gains a third consent source — policy-granted consent recorded as 'auto-approved by policy' — while the prohibit list stays absolute (direct_push_to_protected_branch can never be auto-approved) and --draft still forces consent=false. `run --auto` reads this block to decide which gates it may pass; Zod defaults keep old configs valid (autonomy defaults to draft_only).

- *Why:* Teams tune autonomy per risk appetite in oswald.yml: a sandboxed dbt project can auto-approve create_branch/commit but never open_pull_request or ticket_update. This is the policy surface the safety map says full-auto requires, and it keeps every decision inside the one existing choke point rather than scattering bypass flags.
- *Builds on:* src/core/config/schema.ts PoliciesConfigSchema (require_approval_for/prohibit already there), src/core/approvals/service.ts decision table + ACTION_ALIASES, src/cli/commands/_run.ts resolveConsent.

**Content-addressed async approval queue (oswald approvals / oswald approve <id>)** — score 7.7, effort L

When an auto run hits a gated write, it writes a pending-approval record instead of just exiting: action class, the draft artifact path (pr_summary.md, clarification_comment.md, generated SQL), and a hash of that exact draft content. A human later runs `oswald approve <id>`; the next run/reconcile pass consumes the token, verifies the draft hash still matches, and only then supplies yes=true to ApprovalService. Tokens are single-use and invalidated by any draft change.

- *Why:* Turns synchronous consent flags into asynchronous, tamper-evident approvals without weakening default-deny — you approve a specific artifact, not a class of action. This is the local backbone the roadmap's Slack/Teams approvals would drive (a Slack button just calls `oswald approve <id>`), so it should land first.
- *Builds on:* src/core/approvals/service.ts (new consent source with distinct audit reason), the draft-first artifact flow every tentacle already follows (clarify/pr/update-ticket all draft before gated writes), .oswald/ artifact store for the queue file.

**Shareable policy packs (versioned per-team presets)** — score 6.3, effort M

Extend the roadmapped per-team policy profiles into distributable, Zod-validated YAML packs applied at `oswald init --policy-pack <name|git-url>`: approval require/prohibit lists for the 8 action classes, SQL max_result_rows, SensitiveFieldDetector custom PII patterns, and seed entries for the vague-term glossary — versioned and diffable so a platform team can roll one pack to twenty repos. Packs can only tighten defaults (prohibit list is append-only, --draft override untouchable), preserving fail-closed semantics.

- *Why:* Central data-platform/governance teams get one lever to standardize agent guardrails across squads instead of hand-editing each repo's oswald.yml; individual teams get org-blessed defaults on day one.
- *Builds on:* oswald.yml policy block + Zod config parsing (src/cli/commands/_config.ts, src/core/config), ApprovalService config-vocabulary aliases, SensitiveFieldDetector and SqlSafetyValidator config inputs (src/core/policy), init command.

### Developer Experience & Observability

**Provider resolution report + --strict-providers** — score 8.3, effort S — *PR #1*

Make provider wiring loud and controllable: every command prints a one-line resolution table (warehouse: snowflake→MOCK (snow not on PATH); ticket: mock; repo: mock), and a --strict-providers flag (or policy key) turns any silent fallback into exit-code-1 with a remediation hint. Today `--warehouse snowflake` degrades to MockWarehouseProvider with only a warning.

- *Why:* Eliminates the most dangerous DX trap in the current build — mock results masquerading as EDA evidence — and gives CI users a way to guarantee real execution. Cheap insurance for the tool's core credibility claim (evidence over vibes).
- *Builds on:* selectProviders (src/cli/commands/_providers.ts) is the documented single wiring point where the fallback happens; detectSnow already produces the diagnosis; the standard output block in _run.ts renders the table; state.tools is recorded but unconsumed — this makes it an enforcement input.

**oswald status — at-a-glance run dashboard** — score 7, effort S — *in progress*

A read-only command that renders one screen: current phase, ticket id/provider, requirements.completeness as a progress bar, blockers, unresolved questions count, which canonical artifacts exist vs are missing, provider health, and the recommended next command with its successor. Today this information is scattered across state.yml, `oswald next`, and `oswald doctor`; nothing composes it.

- *Why:* Engineers resuming a run (or a host agent re-orienting after context compaction) get the whole picture in one command instead of cat-ing .oswald/state.yml. Also the natural target for `oswald compact` users checking what survived archiving.
- *Builds on:* readState (src/core/state/store.ts), recommendNextCommand + LINEAR_NEXT, ArtifactManager.exists + canonical names, provider health probes already written for doctor (src/core/doctor, detectSnow). Pure composition of existing readers; no new state.

**Team conventions block (naming, layout, test defaults)** — score 6.7, effort L

A `conventions` section in oswald.yml — model-name prefixes and layer names (stg_/int_/fct_ are currently hardcoded in intake target detection, plan pattern selection, and build scaffolds), folder layout for generated models, default materializations, and default test policy — consumed by the planning tentacle and the build scaffolder, and validated by doctor. Related to but distinct from the roadmap's per-team policy profiles, which cover approvals rather than code style.

- *Why:* Teams with existing dbt conventions (different layer prefixes, folder-per-mart layouts) currently get plans and scaffolds that fight their repo, meaning hand-editing every build output. Convention-aware generation is what makes build --apply output land review-ready instead of foreign.
- *Builds on:* Config schema gains one Zod block; consumers are the hardcoded prefix lists in src/tentacles/intake/parse.ts, pattern/model proposals in src/tentacles/planning/, and scaffold emission in src/cli/commands/_build_models.ts; doctor validates the block. Effort is L because the prefixes are load-bearing in three modules plus tests and the example dbt-duckdb project.

**Run & phase telemetry ledger (runs.jsonl / transitions.jsonl) + oswald stats and status --timeline** — score 6, effort M

Two cheap hooks at existing choke points: runTentacleCommand records one entry per tentacle run (command, start/end wall time, exit code 0/1/2, warnings count, artifacts written, subprocess durations for snow and dbt calls) and advanceWorkflow appends one record per phase transition ({ticket, from_phase, to_phase, ts, completeness, blockers_count}) using the already-injected clock. `oswald status --timeline` renders how the ticket moved through phases and where time went; `oswald stats` aggregates across current and archived runs: cycle time per phase, time spent blocked, how often low intake completeness led to a blocked clarify, questions per ticket. Honest telemetry — subprocess and wall time, not tokens (token/cost capture stays a host-runtime concern, but the ledger gives hosts a place to append it).

- *Why:* Answers 'why did EDA take 40 minutes' and 'when did this run go blocked' without archaeology. Team leads get the first quantitative view of where analytical tickets actually stall (usually clarification and validation); maintainers get the strongest early-MVP feedback signal on which phases are slow or repeatedly re-run; and Oswald gets measurable proof of its own value. Also the raw substrate the ticket-estimation feature needs.
- *Builds on:* runTentacleCommand (src/cli/commands/_run.ts) wraps every pipeline verb and owns exit codes; advanceWorkflow (src/tentacles/base.ts:317) is the single phase-change choke point with injected clock; SnowflakeWarehouseProvider and src/tools/dbt/ are the only subprocess sites; ship/compact archiving conventions locate past runs.

**Explain/teach mode: next --explain + global --explain onboarding cards** — score 6, effort S

Two faces of one feature rendered from the same per-command prompt templates the runtime adapters already maintain. `oswald next --explain` says WHY the recommended command is next: which blockers/unresolved questions gate it, what artifacts it reads/writes, which providers it needs vs what's wired, which consent flags (--execute, --apply, --yes) matter and what they gate — and for blocked state, lists the recorded blockers and the concrete resume path instead of today's 'nothing to run'. A global --explain flag prints a plain-language card before the standard output block: what this phase does, why the evidence-ledger discipline matters here, what the artifacts mean, and what a good human review looks like before advancing.

- *Why:* New users and host agents currently get a bare verb with no rationale; this turns the state machine into a teacher, reduces 'why is it telling me to clarify again' confusion, and fixes a real dead end (blocked is currently terminal as far as next is concerned). New analytical engineers — and skeptical seniors evaluating the tool — learn the opinionated 11-phase workflow by using it instead of reading docs cold, and content stays in sync with the 15 commands automatically. Nearly free to build.
- *Builds on:* src/runtimes/commands.ts (15 per-command prompt docs already written), COMMAND_FOR_STATE + recommendNextCommand + canTransition, state.status.blockers + requirements (src/core/state/schema.ts), tentacle registry metadata (description, requiredTools, optional tools), resolveConsent flag semantics, standard output block in _run.ts.

**oswald doctor --fix** — score 5.7, effort M

Extend doctor from diagnosis to remediation: create a missing .oswald dir, regenerate a corrupt/missing state.yml (offering to reconstruct phase from which canonical artifacts exist), prune state.artifacts entries whose files are gone, fill missing oswald.yml keys with schema defaults, and re-stage runtime templates. Each fix is printed as a proposed action and applied only with an explicit flag, consistent with default-deny.

- *Why:* The failure mode for an early-stage tool is a half-initialized or hand-edited .oswald directory that makes every command error cryptically; --fix converts a support thread into one command. Especially valuable because Zod validation on state.yml currently hard-fails with no recovery path.
- *Builds on:* runDiagnostics check list (src/core/doctor) already classifies ok/warn/fail per concern; createInitialState/writeState + the Zod state schema supply defaults; init's template staging (src/cli/commands/init.ts, src/runtimes/adapters) is reusable for template repair; artifact-existence checks from ArtifactManager.

**oswald view — local read-only web viewer over .oswald** — score 5.3, effort L

A zero-config `oswald view` that serves a localhost page rendering state.yml, the phase timeline, all markdown artifacts (with four-value evidence-ledger tables rendered as such), decision_log.md, and the audit/runs JSONL logs — strictly read-only, no write endpoints, honoring the same PII-redacted artifact content. The concrete delivery of the roadmap's 'audit UI', widened to the whole artifact set.

- *Why:* Stakeholders and reviewers (the humans who must promote assumptions to confirmed at design) get a browsable record without reading raw files in .oswald/; also the demo surface that makes Oswald's durable-artifact story legible to buyers.
- *Builds on:* Everything is already file-based and Zod/JSONL-structured: readState, ArtifactManager reads, decision_log.md from src/tentacles/delivery/, plus the audit and telemetry ledgers as data sources. Needs a small static server + markdown renderer dependency; no changes to tentacles.

**Interactive init wizard + shell completions** — score 5.3, effort M

`oswald init --interactive` walks through runtime selection (detectAdapter pre-selecting), warehouse setup (probing `snow connection list` and offering connection names), dbt project detection, artifact dir, and policy defaults — then writes a commented oswald.yml, which init currently never generates (it only reads config or falls back to defaults). Ships `oswald completions <shell>` generated from the Commander program definition.

- *Why:* First-run success is the whole ballgame for a young npm package: today a user must hand-author oswald.yml from docs to get past mock providers, and the Snowflake connection-name requirement is the top silent-fallback cause. Completions are cheap polish for a 15-verb CLI.
- *Builds on:* registerInit + loadOrDefaultConfig (src/cli/commands/init.ts), config schema + DEFAULT_CONFIG_FILENAME (src/core/config), detectAdapter (src/runtimes/adapters/registry.ts), detectSnow. Needs one prompt library (or node:readline) — first interactive surface, kept out of the non-interactive tentacle path.

### Quality Gates & Review

**oswald review — deterministic dbt code-review tentacle with sqlfluff lint backend** — score 8, effort L

A ninth tentacle (and CLI verb between building and validating in LINEAR_NEXT) that reviews changed SQL + YAML before PR: leftover TODO(human)/TODO_upstream scaffold markers from build, hardcoded table refs instead of ref()/source(), select * in marts, naming-prefix violations, missing _schema.yml docs, and divergence between plan.md's proposed tests and what schema.yml declares. Writes code_review.md with severity-graded findings tagged in the four-value evidence ledger; blocking findings land the workflow in blocked (exit 2). A src/tools/sqlfluff/ runner following the dbt-runner pattern (argv-only spawn, timeout, graceful 'lint skipped' when the binary is absent) offloads style/layout checking, running sqlfluff lint --format json on changed models with the dialect from standards.sql_dialect and mapping violations into the same findings.

- *Why:* Catches the exact failure mode Oswald creates by design — build emits TODO scaffolds for humans to fill — before a broken model reaches PR, giving reviewers a machine-verified checklist instead of raw diffs. Delegating style to the industry-standard linter keeps the tentacle's own rules focused on dbt semantics and honors teams' existing .sqlfluff configs instead of inventing a parallel convention system.
- *Builds on:* Tentacle base class + registry (src/tentacles/base.ts, registry.ts), runTentacleCommand; changed-file classification from src/tentacles/delivery/parse.ts + RepoProvider.changedFiles; TODO markers are the known output contract of src/cli/commands/_build_models.ts; new state in src/core/workflow/states.ts (LINEAR_NEXT, COMMAND_FOR_STATE); subprocess pattern from src/tools/dbt/runner.ts and src/tools/snowflake; standards.sql_dialect in StandardsConfigSchema.

**Read-only data-diff / reconciliation runner (sandbox vs prod)** — score 8, effort L

Generate read-only comparison SQL between a sandbox-built model and its prod counterpart or upstream source: row counts, per-column aggregate checksums (null rates, sums, min/max, distinct counts), and key-set differences via EXCEPT — every statement re-validated through SqlSafetyValidator and LIMIT-capped, executed via the existing Snowflake snow-CLI provider. Results land in reconciliation.md with confirmed/inferred evidence tags and tolerance-based pass/fail feeding validate's blocking logic.

- *Why:* Answers the reviewer's real question — 'does the new model agree with prod?' — with warehouse evidence instead of eyeballing. Extends the one integration that is already real (Snowflake read-only) rather than waiting on MCP.
- *Builds on:* SQL generation pattern from src/tentacles/eda/sql.ts (generate → re-validate through src/core/policy/sql-safety.ts → execute via SnowflakeWarehouseProvider); tolerance-based row-count reconciliation already in src/tentacles/validation/ gets generalized; PII redaction from src/core/policy/sensitive.ts on result persistence.

**Ticket readiness gate with auto-drafted clarification requests** — score 7.3, effort M — *in progress*

Promote intake's existing weighted completeness score into a first-class, dimension-by-dimension readiness scorecard (grain declared, sources named, acceptance criteria, targets, stakeholders, metric definitions, due date) written to readiness.md and state.yml, with a configurable policies.readiness.min_score enforced at the clarification→context transition: below threshold the workflow lands blocked (exit 2) unless a human override is recorded in decision_log.md. On failure, auto-generate a structured 'missing information' request keyed to the failed dimensions (e.g. 'grain not declared: one row per what?'), routed to the stakeholders clarify already identifies and posted via the approval-gated TicketProvider.postComment; re-running intake after the ticket is updated re-scores and records the readiness delta so the loop is visible.

- *Why:* Analytical engineers stop burning EDA/design cycles on tickets that lack a grain or acceptance criteria; managers get a deterministic, auditable 'ready to start' signal instead of vibes. And the pipeline doesn't just refuse under-specified tickets — it drafts the exact ask that unblocks them. Works today draft-only against the mock ticket provider and becomes fully live when Model A MCP lands.
- *Builds on:* src/tentacles/intake/index.ts completeness weights (summary .2, requirements .25, AC .3, sources .15, targets .1) in state.requirements.completeness; gating via advanceWorkflow + canTransition; threshold in PoliciesConfigSchema; blocked/exit-2 convention from _run.ts; clarification tentacle's question classification, stakeholder routing, and approval-gated comment draft; ticket_update action class in src/core/approvals/service.ts.

**dbt test coverage scorer (finally enforce require_tests_for_new_models)** — score 7.3, effort M

Parse manifest.json (indexer already exists in src/tools/dbt/parse.ts) to compute per-model coverage for new/changed models: unique+not_null on the grain keys declared in design's metric_spec.yml, accepted_values, relationships, and doc presence. Emit test_coverage.md with a 0-1 score per model, and turn the currently-unenforced standards.require_tests_for_new_models and require_model_docs config flags into real gates consumed by review/validate.

- *Why:* Two config promises that today do nothing become enforced policy; reviewers see 'fct_retention: grain keys untested' instead of discovering it in prod. Deterministic, offline, no warehouse needed.
- *Builds on:* indexManifest in src/tools/dbt/parse.ts (only used for run-results detail today); check taxonomy in src/tools/dbt/checks.ts (classifyDbtTest); grain/key expectations from design's metric_spec.yml and planning's proposed tests; the dormant flags in StandardsConfigSchema.

**Baseline snapshots + regression detection in validate** — score 6.7, effort M

Persist each validate run's typed dbt results and each executed EDA run's profile metrics (row counts, null rates, distinct counts, grain verdicts) as versioned baseline JSON under .oswald/baselines/. On subsequent runs, diff against the baseline and flag regressions — a test that flipped pass→fail, row counts drifting beyond tolerance, a grain that was unique and now has duplicates — as blocking or warning findings in validation_report.

- *Why:* Turns validate from a point-in-time check into change detection: iterating on a model mid-ticket surfaces what got worse, not just what fails now. Also gives ship a concrete 'nothing regressed since last green run' guarantee.
- *Builds on:* Typed run_results parsing in src/tools/dbt/parse.ts + check taxonomy in checks.ts; EDA profile outputs from src/tentacles/eda/; ArtifactManager for versioned persistence; validation tentacle's blocking-failure → blocked → exit-2 path.

**Artifact drift checker (stale upstream detection)** — score 6.7, effort S — *in progress*

Record a content hash of each phase's input artifacts at write time (intake.md hash consumed by design, plan.md hash consumed by build, etc.) in the state artifacts map, and add a drift check — run inside oswald doctor and as a hard gate in ship — that flags any phase whose upstream artifact changed after it ran (e.g. intake re-run after clarification answers arrived, but design/plan were not regenerated).

- *Why:* Prevents the quiet failure where a mid-pipeline ticket update invalidates the design but the stale plan still ships; ship's gate gains a machine check instead of trusting that artifact filenames exist.
- *Builds on:* state.yml artifacts key→path map + timestamps (src/core/state/schema.ts); ArtifactManager as the single write point for hashing; doctor (src/cli/commands/doctor.ts) for reporting; ship.ts's existing pure-gate pattern for enforcement.

### Host-Agent Intelligence & Organizational Learning

**Cross-ticket knowledge base (org glossary + decision-log mining)** — score 7.7, effort L

A durable .oswald/knowledge/ store built by mining artifacts Oswald already produces: decision_log.md entries appended by the delivery tentacle, confirmed metric definitions from design's metric_spec.yml, and resolved open_questions from clarify. On the next ticket, intake's vague-term detector and design's 'UNDEFINED — requires human definition' formula path consult the glossary first, so a term the org confirmed once ('active user' = login in 30d) arrives as 'inferred (from AE-1234 decision log)' instead of regenerating the same blocking question.

- *Why:* Teams stop re-litigating the same metric definitions every ticket — the biggest recurring time sink in analytical engineering. Also auto-builds an org glossary for new team members, and it compounds: every shipped ticket makes the next intake score higher and clarify shorter.
- *Builds on:* ArtifactManager, delivery's decision_log.md append (src/tentacles/delivery/index.ts), design's metric_spec.yml, intake parse.ts vague-word list (11 terms), context tentacle's token-overlap similarity ranker for retrieval; evidence-ledger kinds in src/tentacles/base.ts give provenance tagging for free.

**Host-LLM review layer via runtime adapters (oswald-review slash command)** — score 7, effort M

Render an oswald-review command prompt through the runtime-adapter registry (Claude Code gets .claude/commands/oswald-review.md; generic/codex/gemini get staged prompts) that layers judgment-heavy review — business-logic correctness vs acceptance criteria, join semantics, performance smells like fan-out joins — on top of the deterministic code_review.md findings. Follows the Model B pattern: connector-aware GitHub MCP read tools for diffs, diff content wrapped as untrusted evidence, verdict written back as an appendix the deterministic gate can require.

- *Why:* Correctness review genuinely needs reasoning the deterministic library cannot provide (Oswald's own no-live-LLM rule); this delivers it the Oswald way — host runtime supplies the judgment, library supplies the checklist, gates, and artifact contract. Directly extends the roadmap's 'live model integration for judgment-heavy tentacles'.
- *Builds on:* RuntimeAdapter renderCommands + registry (src/runtimes/adapters/), the claude-code adapter's CONNECTOR_MAP (mcp__github__* read tools already wired for context/pr), ExternalContentSanitizer.wrap (src/core/policy/external-content.ts) for diff content, the review tentacle's code_review.md as the deterministic substrate.

**Adversarial reviewer agent (analyst + skeptic pair)** — score 6, effort M

Extend the claude-code adapter's renderAgents (which today emits only .claude/agents/oswald-analyst.md) to also emit oswald-reviewer.md: a read-only skeptic agent invoked after eda/design/plan that re-reads the phase artifacts and challenges every assumption-tagged item, ASSUMED formula skeleton, and unknown/duplicates grain verdict, writing challenges back as open_question entries before `oswald next` advances. Rule-of-Two clean — it holds only read powers, mirroring how the existing oswald-eda/oswald-model skill split assigns disjoint power sets.

- *Why:* The judgment-heavy phases are exactly where a single agent confirms its own assumptions; a structurally separate reviewer with an adversarial prompt measurably reduces rubber-stamping, and blocked-on-open-question is already a first-class workflow concept so no engine change is needed.
- *Builds on:* RuntimeAdapter.renderAgents (src/runtimes/adapters/types.ts, claude-code.ts), the four-value evidence ledger, existing per-phase artifacts (eda.md, metric_spec.yml, plan manifest), blocked-state semantics in src/core/workflow/states.ts.

**LLM-judge completeness scoring via a JudgmentProvider seam** — score 5.3, effort M

Define a JudgmentProvider interface alongside the four provider interfaces (read-only: scoreCompleteness, critiqueQuestions), wired through selectProviders. Intake's deterministic weighted completeness stays authoritative; when a judge is configured (host runtime or future MCP model endpoint) its score and disagreement rationale are recorded in the evidence ledger as inferred/open_question, never silently overriding state.requirements.completeness. In Claude Code, the adapter's slash-command prompts (Model B pattern) instruct the host model to act as the judge and write its critique into the intake artifact.

- *Why:* Catches what regex can't — a ticket that hits every structural checkbox but is semantically incoherent — while preserving the no-live-LLM-in-the-library guarantee and the human-promotes-assumptions discipline. First concrete consumer of the deferred live-model seam.
- *Builds on:* Provider-interface pattern + selectProviders (src/cli/commands/_providers.ts), requirements.completeness (src/core/state/schema.ts), EvidenceKind (src/tentacles/base.ts), CONNECTOR_MAP prompt rendering (src/runtimes/adapters/claude-code.ts).

**Stakeholder brief generator (oswald brief)** — score 5.3, effort S

A deterministic command that assembles an exec-readable status from artifacts that already exist: what was asked (intake gist), what is confirmed vs assumed (evidence-ledger tallies), current phase and blockers (state.yml), and known limitations — reusing compact.ts's one-line gisting and the delivery tentacle's drafting pattern, with an explicit host-agent polish placeholder. Posting anywhere routes through the existing ticket_update / write_external_document approval classes, draft-first like everything else.

- *Why:* Analytical-engineering work is chronically illegible to requesting stakeholders; a one-command business-language status turns .oswald/ artifacts into trust with product/finance without the engineer hand-writing updates. Natural payload for the roadmapped Slack/Teams notification channel, but the content generation itself is not on the roadmap. Zero new external dependencies.
- *Builds on:* compact.ts gist logic, delivery tentacle's jira_update.md drafting, ApprovalService action classes (src/core/approvals/service.ts), ArtifactManager.

**Golden-ticket eval harness for tentacle quality (oswald eval)** — score 5, effort M

A corpus of annotated tickets (expected requirements/AC/sources/targets extraction, expected completeness band, expected blocking-vs-non-blocking question classification, expected grain/pattern selection) plus an `oswald eval` runner that executes every registered tentacle against the corpus with mock providers and scores precision/recall per extractor, emitting a regression report. Because tentacles are deterministic with injected clocks and no live LLM, runs are perfectly repeatable — and the same harness becomes the baseline scorer when live-model prompts start replacing regex heuristics.

- *Why:* Maintainers get a safety net for evolving the fragile keyword/regex heuristics (intake section aliases, clarify signal lists, plan pattern selection) without silent quality regressions, and a principled way to prove a future LLM-backed tentacle actually beats the deterministic one before shipping it. Prerequisite for honest live-model integration.
- *Builds on:* Tentacle registry + TentacleContext construction (src/cli/commands/_run.ts buildContext), mock providers in src/tools/providers/mock/, existing fixtures (examples/tickets/sample-retention-ticket.md, mock-eda-results.json), clock injection in the state store.

**Ticket estimation from past runs** — score 4, effort M

At intake time, bucket the new ticket against archived runs using the context tentacle's existing token-overlap similarity plus deterministic features intake already computes (completeness score, requirement/source/target counts, scope-risk flags from clarify's thresholds), and report median/p80 phase durations of the bucket from the telemetry transitions ledger as an expected-effort band with explicit 'inferred, n=4 similar tickets' provenance. Pure quantile arithmetic — no model, no fabricated point estimates, declines to estimate below a minimum sample size.

- *Why:* Sprint planning for analytics work is notoriously guesswork; even a coarse evidence-tagged band ('similar tickets took 2–5 days, mostly stuck in clarification') beats gut feel and gives managers an honest signal at ticket-triage time.
- *Builds on:* Depends on the run & phase telemetry ledger; reuses context tentacle similarity ranking (src/tentacles/context/), intake completeness features (parse.ts), clarify scope-risk thresholds (src/tentacles/clarification/analyze.ts), evidence-ledger provenance tagging.

### Data Platform Integrations

**dbt Semantic Layer / Cube artifact emission with metric-collision check** — score 6.7, effort M

Upgrade the design tentacle's prose 'dbt Semantic Layer recommendations' into real emitted artifacts: valid semantic_models/metrics YAML (dbt SL) or Cube schema files, gated on human-confirmed formulas (UNDEFINED formulas emit commented-out stubs). Optionally query an existing semantic layer read-only (dbt SL GraphQL / Cube meta API) during design to flag metric-name collisions with already-governed metrics.

- *Why:* Prevents the classic failure mode Oswald exists to stop — an agent shipping a second, slightly different 'revenue' — by checking the governed metric registry before design is approved, and turns design output into deployable semantic-layer code rather than documentation. Refines the existing 'semantic layer' roadmap item with concrete targets and behavior.
- *Builds on:* src/tentacles/design/ already emits metric_spec.yml + a semantic plan and enforces the never-invent-formulas rule (UNDEFINED/ASSUMED skeleton), so emission is a rendering layer over existing structures; the collision probe fits the DocumentProvider/ToolProvider invoke() shape and the Model A MCP client once wired.

**Data-quality bridge: Elementary / Great Expectations** — score 5.7, effort M

Two-way bridge in the validate tentacle: export AC-derived typed expectations as a Great Expectations suite JSON (or Elementary dbt-test YAML), and ingest existing Elementary results / GE validation outputs as confirmed evidence in the ledger instead of re-deriving checks Oswald cannot express. Ingested reports flow through ExternalContentSanitizer.wrap like all untrusted external text.

- *Why:* Teams with an established DQ stack won't accept a parallel, weaker check system; ingesting their results lets Oswald's ship gate reflect the organization's real quality bar, and exporting suites means Oswald's AC classification work survives beyond the ticket as durable monitoring.
- *Builds on:* Validation's regex AC classifier already produces a typed intermediate representation one serializer away from a GE suite; Elementary results live in warehouse tables, readable through the existing read-only WarehouseProvider.executeReadOnlySql path (SQL gate + redaction apply for free).

**Orchestrator freshness probe (Airflow / Dagster, read-only)** — score 5.7, effort M

A read-only OrchestratorProvider queried during context and EDA: Airflow REST API (dag runs, task states) or Dagster GraphQL (asset materialization timestamps) to answer 'when did the upstream sources for this ticket last land successfully?'. Results become confirmed/inferred evidence in eda.md freshness sections and a scope-risk signal in clarify (stale upstream = blocking question). Mock-first like every other provider so tests stay offline.

- *Why:* Freshness verdicts from SQL alone (max(loaded_at)) can't distinguish 'pipeline broken' from 'pipeline slow'; orchestrator run state is the ground truth engineers actually check. Catching a red upstream DAG at clarify time prevents building an entire model on a dead feed.
- *Builds on:* Introduces a fifth provider kind next to Ticket/Warehouse/Repo/Document in src/tools/providers/types.ts (all-read capabilities, no new approval classes needed); EDA freshness checks and clarify's scope-risk detector are the consumption points; API responses route through ExternalContentSanitizer.wrap.

**Multi-warehouse CLI driver family: DuckDB first, then BigQuery / Postgres / Redshift / Databricks** — score 5.3, effort L

Generalize the proven snow-CLI pattern (argv-only spawn, SqlSafetyValidator pre-spawn, PII redaction post-result, binary detection with graceful mock fallback) into an abstract CliWarehouseProvider family. Phase 1 (S): a DuckDbWarehouseProvider shelling out to the duckdb binary (-json output) against a local .duckdb file, implementing listSchemas/listTables/describeTable/executeReadOnlySql via information_schema — the config schema already defaults default_warehouse to "duckdb" (src/core/config/schema.ts:13) but only Snowflake is implemented. Phase 2 (L): `bq query --format=json`, `psql --csv` for Postgres/Redshift, and the databricks CLI, plus a dialect field in EDA SQL generation since freshness/quoting syntax diverges per engine.

- *Why:* DuckDB closes a promise the config makes and fixes the documented dead-end where the fully-offline demo can never confirm grain — the examples/ dbt-duckdb project gives EDA a real zero-credential database, making the end-to-end demo genuinely green. The wider family then removes the Snowflake-only cap on the addressable market (these CLIs cover most dbt shops) while keeping the credential story intact: auth lives in vendor tools (gcloud ADC, .pgpass, databricks profiles), no secrets ever enter oswald.yml.
- *Builds on:* SnowflakeWarehouseProvider pattern (src/tools/snowflake/warehouse.ts, runner.ts, detect.ts), selectProviders (src/cli/commands/_providers.ts), WarehouseProvider interface (src/tools/providers/types.ts:163), EDA SQL generation (src/tentacles/eda/sql.ts); the unimplemented snowsql dialect reservation (runner.ts:196) shows the dialect seam was anticipated.

**dbt Cloud validation backend** — score 4.7, effort M

A dbt Cloud execution path for the validate tentacle: trigger a job via the dbt Cloud Administrative API, poll the run, download run_results.json/manifest.json artifacts, and feed them through the existing result-to-check mapper. Config adds account/job IDs plus an env-var-referenced token, mirroring the mcp_servers env-reference convention.

- *Why:* Teams standardized on dbt Cloud often cannot (or won't) run dbt-core locally against production profiles; this lets validate produce real evidence in those shops without local warehouse credentials, and links the dbt Cloud run URL into pr_summary.md for reviewers.
- *Builds on:* src/tools/dbt/runner.ts already isolates 'the one place Oswald shells out to dbt' and reads run_results artifacts; src/tools/dbt/checks.ts maps results to ValidationChecks — a CloudDbtRunner implementing the same typed-result contract swaps in behind it. Extends the roadmap's 'richer dbt via dbt-mcp' item with the Cloud API path.

**SQLMesh project support (plan/build/validate)** — score 3.3, effort L

Detect a SQLMesh project (config.yaml/config.py) alongside dbt detection, then: plan emits SQLMesh model + audit proposals instead of dbt schema tests, build --apply scaffolds SQLMesh MODEL headers with TODO(human) bodies, and validate runs `sqlmesh plan --dry-run` + `sqlmesh audit` (subprocess) mapping results into the same typed checks. Scoped to build+validate first; plan-tentacle pattern selection stays shared.

- *Why:* SQLMesh is the fastest-growing dbt alternative and its virtual-environment/plan-diff model actually fits Oswald's evidence-ledger philosophy better than dbt's (plans are dry-runnable by design). First-mover support differentiates Oswald from dbt-only agent tooling.
- *Builds on:* The dbt runner's configurable-invocation pattern (splitInvocation, timeout, typed outcomes) generalizes to a sqlmesh runner; validation's typed expectations (grain/uniqueness/non_null/accepted_values/freshness/row_count) map cleanly onto SQLMesh audits; build's never-overwrite .new-file convention in _build_models.ts is transpiler-agnostic.
