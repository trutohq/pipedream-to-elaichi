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
}

export interface TriggerReport {
  source: string
  became: string
  status: Status
  notes: string[]
}

export interface WorkflowReport {
  name: string
  input_file: string
  output_file: string
  pipedream_id?: string
  triggers: TriggerReport[]
  steps: StepReport[]
  /** Apps to connect again in Elaichi (Pipedream exports no credentials). */
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
