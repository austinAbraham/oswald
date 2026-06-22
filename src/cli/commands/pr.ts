import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders } from "./_providers.js";

const OptionsSchema = z.object({
  draft: z.boolean().optional(),
  open: z.boolean().optional(),
  yes: z.boolean().optional(),
  cwd: z.string(),
});

export function registerPr(program: Command): void {
  program
    .command("pr")
    .description("Package the change into a PR summary (opening the PR is approval-gated)")
    .argument("<ticket>", "ticket id this PR targets")
    .option("--draft", "produce the PR summary as a draft only (default)")
    .option("--open", "open the pull request (requires approval + a repo provider)")
    .option("-y, --yes", "grant explicit approval for gated side effects")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald pr TICKET-42            # draft pr_summary.md only\n  oswald pr TICKET-42 --open --yes",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      // Opening a PR needs a repo provider; drafting does not.
      const providers = selectProviders({ cwd, repo: Boolean(opts.open) });

      const { exitCode } = await runTentacleCommand({
        id: "delivery",
        command: "pr",
        cwd,
        ticketId: ticket,
        options: { decisionNote: "pr CLI" },
        providers,
        approval: {
          ...(opts.yes ? { yes: true } : {}),
          ...(opts.open ? { open: true } : {}),
          ...(opts.draft ? { draft: true } : {}),
        },
      });
      process.exitCode = exitCode;
    });
}
