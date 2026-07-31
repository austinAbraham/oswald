import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders } from "./_providers.js";

const OptionsSchema = z.object({
  draftComment: z.boolean().optional(),
  postComment: z.boolean().optional(),
  yes: z.boolean().optional(),
  overrideReadiness: z.string().optional(),
  json: z.boolean().optional(),
  strictProviders: z.boolean().optional(),
  cwd: z.string(),
});

export function registerClarify(program: Command): void {
  program
    .command("clarify")
    .description("Triage open questions and draft a clarification comment")
    .argument("<ticket>", "ticket id this clarification targets")
    .option("--draft-comment", "render the clarification comment as a draft only")
    .option("--post-comment", "post the clarification comment (requires approval)")
    .option(
      "--override-readiness <reason>",
      "proceed past a failing readiness gate, recording the reason as a decision",
    )
    .option("-y, --yes", "grant explicit approval for gated side effects")
    .option("--json", "emit one machine-readable JSON step report on stdout (CI mode)")
    .option("--strict-providers", "fail (exit 1) instead of falling back to a mock provider")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      '\nExamples:\n  oswald clarify TICKET-42\n  oswald clarify TICKET-42 --post-comment --yes\n  oswald clarify TICKET-42 --override-readiness "PM confirmed scope verbally"',
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      // Posting needs a ticket provider; drafting does not.
      const { providers, resolution } = selectProviders({
        cwd,
        ticket: Boolean(opts.postComment),
      });

      const { exitCode } = await runTentacleCommand({
        id: "clarification",
        command: "clarify",
        cwd,
        ticketId: ticket,
        options: {
          reason: "clarify CLI",
          ...(opts.overrideReadiness
            ? { overrideReadiness: opts.overrideReadiness }
            : {}),
        },
        providers,
        providerResolution: resolution,
        ...(opts.strictProviders ? { strictProviders: true } : {}),
        approval: {
          ...(opts.yes ? { yes: true } : {}),
          ...(opts.postComment ? { post: true } : {}),
          ...(opts.draftComment ? { draft: true } : {}),
        },
        json: Boolean(opts.json),
      });
      process.exitCode = exitCode;
    });
}
