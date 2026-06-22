import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders } from "./_providers.js";

const OptionsSchema = z.object({
  draft: z.boolean().optional(),
  post: z.boolean().optional(),
  yes: z.boolean().optional(),
  cwd: z.string(),
});

export function registerUpdateTicket(program: Command): void {
  program
    .command("update-ticket")
    .description("Write results back to the ticket (posting is approval-gated)")
    .argument("<ticket>", "ticket id to update")
    .option("--draft", "produce the ticket update as a draft only (default)")
    .option("--post", "post the update to the ticket (requires approval + provider)")
    .option("-y, --yes", "grant explicit approval for gated side effects")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald update-ticket TICKET-42          # draft jira_update.md only\n  oswald update-ticket TICKET-42 --post --yes",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      // Posting needs a ticket provider; drafting does not.
      const providers = selectProviders({ cwd, ticket: Boolean(opts.post) });

      const { exitCode } = await runTentacleCommand({
        id: "delivery",
        command: "update-ticket",
        cwd,
        ticketId: ticket,
        options: { decisionNote: "update-ticket CLI" },
        providers,
        approval: {
          ...(opts.yes ? { yes: true } : {}),
          ...(opts.post ? { post: true } : {}),
          ...(opts.draft ? { draft: true } : {}),
        },
      });
      process.exitCode = exitCode;
    });
}
