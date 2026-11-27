import type { LimitId } from './limits.ts'

// Elaichi workflow definition (the subset this importer writes) and the migration report.
// The shapes follow Elaichi's live validator (`elaichi__automation__schema`): every object is strict,
// so a step may carry only the fields its type allows. `check.ts` enforces that locally.

export interface Trigger {
  key: string
  type: 'manual' | 'cron' | 'webhook'
  [field: string]: unknown
}

export interface Step {
  key: string
  type: string
  name?: string
  description?: string
  run_if?: string
  [field: string]: unknown
}

export interface Definition {
  schema_version: 1
  triggers: Trigger[]
  toolboxes: string[]
  steps: Step[]
}

/** Exactly the body of `POST /automation` (name, description, definition). */
export interface DraftBody {
  name: string
  description: string
  definition: Definition
}

/**
 * mapped     — converted, nothing known left to do (still test-run it).
 * needs_work — converted into something close, with named TODOs.
 * no_match   — nothing in Elaichi does this automatically; a TODO step holds its place.
 */
export type Status = 'mapped' | 'needs_work' | 'no_match'

/**
 * Kinds of work left on a step. AGENTS.md gives the procedure for each.
 * - set_toolbox: the call_tool step names a placeholder toolbox (tbx_REPLACE_…)
 * - write_tool_args: the tool's arguments are missing, partial or unchecked
 * - port_code: rewrite the step's code (kept in a comment) as JavaScript
 * - fix_code: the wrapped Node.js code uses something Elaichi code cannot do (see notes)
 * - rebuild_with_tools: the step calls the network or a connected account; rebuild those calls as call_tool steps
 * - find_tool: the app action is not in this importer's table; look for a matching Elaichi tool
 * - no_connector: Elaichi has no connector for the app
 * - reenter_secret: a redacted secret prop must be entered again
 * - delete_step: the step has no job in Elaichi (for example returning an HTTP response)
 * - rebuild_control_flow: branch arms need their place and conditions
 * - manual: anything else; read the notes
 */
export type TodoKind =
  | 'set_toolbox'
  | 'write_tool_args'
  | 'port_code'
  | 'fix_code'
  | 'rebuild_with_tools'
  | 'find_tool'
  | 'no_connector'
  | 'reenter_secret'
  | 'delete_step'
  | 'rebuild_control_flow'
  | 'manual'

export interface StepReport {
  /** The Pipedream step name (`namespace`). */
  namespace: string
  /** What the step was in Pipedream: "node code", "python code", "action slack_v2-send-message@0.3.2", … */
  source: string
  /** Keys of the Elaichi steps written for it (empty never happens: a TODO step always holds its place). */
  elaichi_keys: string[]
  /** What it became, in a few words. */
  became: string
  status: Status
  notes: string[]
  /** Set for steps that sat inside a control-flow branch in Pipedream. */
  branch?: string
  /** What is left to do, as fixed kinds an AI coding agent can act on. Empty when nothing is left. See AGENTS.md. */
  todo: TodoKind[]
  /** Elaichi limits this step runs into (ids from src/limits.ts; migration-plan.json explains each). */
  limits: LimitId[]
}

export interface TriggerReport {
  source: string
  became: string
  status: Status
  notes: string[]
  limits?: LimitId[]
}

export interface WorkflowReport {
  name: string
  input_file: string
  output_file: string
  pipedream_id?: string
  triggers: TriggerReport[]
  steps: StepReport[]
  /** Workflow-wide Elaichi limits it runs into (too many steps or code steps). */
  limits: LimitId[]
  /** Apps to connect in Elaichi. The export holds no credentials: the `connections` command moves the accounts it can. */
  reconnect: string[]
  /** Secret props Pipedream redacted: re-enter them. */
  secrets: string[]
  /** Workflow-level notes, including manifest warnings. */
  notes: string[]
  /** Problems the local shape check found in the written draft. */
  shape_issues: string[]
  summary: Record<Status, number>
}

export interface ProjectReport {
  generated_at: string
  input: string
  workflows: WorkflowReport[]
  /** Workflows the manifest lists but did not export, files the manifest names but are missing, truncation. */
  not_converted: { name: string; reason: string }[]
  notes: string[]
}
