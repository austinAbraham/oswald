import { z } from "zod";
import { WORKFLOW_STATES } from "../workflow/states.js";

/** Zod schema for `.oswald/state.yml`. */

export const STATE_VERSION = 1;

export const ToolStatusSchema = z.object({
  status: z.string(), // e.g. "available" | "unavailable" | "unknown"
});

export const StateProjectSchema = z.object({
  name: z.string(),
  root: z.string(),
});

export const StateTicketSchema = z.object({
  id: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});

export const StateStatusSchema = z.object({
  phase: z.enum(WORKFLOW_STATES),
  last_command: z.string().nullable().default(null),
  next_recommended_command: z.string().nullable().default(null),
  blockers: z.array(z.string()).default([]),
});

export const StateRequirementsSchema = z.object({
  completeness: z.number().min(0).max(1).default(0),
  unresolved_questions: z.array(z.string()).default([]),
  acceptance_criteria_found: z.boolean().default(false),
});

export const StatePolicySchema = z.object({
  mode: z.string().default("standard"),
  writes_require_approval: z.boolean().default(true),
  warehouse_read_only: z.boolean().default(true),
});

export const StateArtifactsSchema = z.record(z.string()).default({});

export const StateTimestampsSchema = z.object({
  created_at: z.string(),
  updated_at: z.string(),
});

export const OswaldStateSchema = z.object({
  version: z.number().int().default(STATE_VERSION),
  project: StateProjectSchema,
  ticket: StateTicketSchema.default({ id: null, provider: null, url: null }),
  status: StateStatusSchema,
  requirements: StateRequirementsSchema.default({}),
  tools: z.record(ToolStatusSchema).default({}),
  policy: StatePolicySchema.default({}),
  artifacts: StateArtifactsSchema,
  timestamps: StateTimestampsSchema,
});

export type ToolStatus = z.infer<typeof ToolStatusSchema>;
export type StateProject = z.infer<typeof StateProjectSchema>;
export type StateTicket = z.infer<typeof StateTicketSchema>;
export type StateStatus = z.infer<typeof StateStatusSchema>;
export type StateRequirements = z.infer<typeof StateRequirementsSchema>;
export type StatePolicy = z.infer<typeof StatePolicySchema>;
export type StateTimestamps = z.infer<typeof StateTimestampsSchema>;
export type OswaldState = z.infer<typeof OswaldStateSchema>;
