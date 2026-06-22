import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders } from "./_providers.js";

const OptionsSchema = z.object({
  localOnly: z.boolean().optional(),
  includeDocs: z.boolean().optional(),
  includePrs: z.boolean().optional(),
  includeTickets: z.boolean().optional(),
  cwd: z.string(),
});

export function registerContext(program: Command): void {
  program
    .command("context")
    .description("Gather existing warehouse/repo/doc context so work is not duplicated")
    .argument("<ticket>", "ticket id to scope the context search")
    .option("--local-only", "scan the local repo only; pull no remote context")
    .option("--include-docs", "include related documents (needs a doc provider)")
    .option("--include-prs", "include related PRs (needs a repo provider)")
    .option("--include-tickets", "include related tickets (needs a ticket provider)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald context TICKET-42 --local-only\n  oswald context TICKET-42 --include-tickets --include-docs",
    )
    .action(async (ticket: string, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      const localOnly = Boolean(opts.localOnly);
      const providers = selectProviders({
        cwd,
        localOnly,
        repo: !localOnly && Boolean(opts.includePrs),
        ticket: !localOnly && Boolean(opts.includeTickets),
        document: !localOnly && Boolean(opts.includeDocs),
      });

      const { exitCode } = await runTentacleCommand({
        id: "context",
        command: "context",
        cwd,
        ticketId: ticket,
        options: { scanRoot: cwd },
        providers,
      });
      process.exitCode = exitCode;
    });
}
