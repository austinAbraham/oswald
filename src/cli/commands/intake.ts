import * as path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { runTentacleCommand } from "./_run.js";
import { selectProviders } from "./_providers.js";

const OptionsSchema = z.object({
  fromFile: z.string().optional(),
  provider: z.enum(["jira", "github", "local", "mock"]).optional(),
  output: z.string().optional(),
  cwd: z.string(),
});

export function registerIntake(program: Command): void {
  program
    .command("intake")
    .description("Ingest a ticket and draft structured requirements")
    .argument(
      "[ticketOrInput]",
      "ticket id (with a provider) or inline ticket text",
    )
    .option("--from-file <path>", "read raw ticket markdown from a local file")
    .option("--provider <name>", "ticket source: jira|github|local|mock")
    .option("--output <dir>", "artifact output dir override (advisory)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .addHelpText(
      "after",
      "\nExamples:\n  oswald intake --from-file ./ticket.md\n  oswald intake TICKET-42 --provider mock",
    )
    .action(async (ticketOrInput: string | undefined, raw: unknown) => {
      const opts = OptionsSchema.parse(raw);
      const cwd = path.resolve(opts.cwd);

      // A provider was requested → wire a (mock) ticket provider; otherwise the
      // local-file / inline path needs no provider at all.
      const wantsProvider = Boolean(opts.provider && opts.provider !== "local");
      const providers = selectProviders({
        cwd,
        ticket: wantsProvider,
      });

      // Distinguish "looks like a ticket id" from "inline pasted text". A
      // positional that looks like an id is ALWAYS the ticket id (even with
      // --from-file, where the file is the content and the positional is the
      // id). Only treat it as inline rawText when it is clearly free text and
      // no file was supplied.
      const looksLikeId =
        ticketOrInput !== undefined && /^[A-Za-z0-9][\w-]{1,63}$/.test(ticketOrInput);
      const ticketId = looksLikeId ? ticketOrInput : undefined;
      const rawText =
        !opts.fromFile && ticketOrInput !== undefined && !looksLikeId
          ? ticketOrInput
          : undefined;

      const options: Record<string, unknown> = {};
      if (opts.fromFile) options.fromFile = path.resolve(cwd, opts.fromFile);
      if (rawText !== undefined) options.rawText = rawText;

      const { exitCode } = await runTentacleCommand({
        id: "intake",
        command: "intake",
        cwd,
        ...(ticketId ? { ticketId } : {}),
        options,
        providers,
        initStateIfMissing: true,
      });
      process.exitCode = exitCode;
    });
}
