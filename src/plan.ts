import { LIMITS, type LimitId } from './limits.ts'
import { isObj, type PdStep, type PdWorkflow } from './parse.ts'
import type { ProjectReport, Status, TodoKind, WorkflowReport } from './types.ts'

/** One piece of work left in a draft, with everything an agent needs to do it without reading the export. */
export interface PlanItem {
  /** `<draft file>#<elaichi key>`, `<draft file>#trigger:<n>` or `<draft file>#workflow`. */
  id: string
  target: 'step' | 'trigger' | 'workflow'
  /** The Pipedream step name, for a step. */
  pipedream_step?: string
  /** Keys of the draft steps to edit. */
  elaichi_keys: string[]
  status: Status
  kinds: TodoKind[]
  reasons: string[]
  limits: LimitId[]
  /** The Pipedream original: the code for a code step, the component and props for an action. */
  original?: { language?: string; code?: string; component?: string; props?: Record<string, unknown> }
}

export interface MigrationPlan {
  schema: 'pipedream-to-elaichi/migration-plan@1'
  generated_at: string
  input: string
  /** The playbook for working through this plan. */
  instructions: string
  limits: Record<string, { limit: string; instead: string }>
  workflows: {
    name: string
    draft_file: string
    pipedream_id?: string
    reconnect: string[]
    secrets: string[]
    items: PlanItem[]
  }[]
  not_converted: ProjectReport['not_converted']
}

/** Props as the agent should see them: connected accounts shown as such, secrets left redacted. */
function safeProps(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, isObj(v) && 'authProvisionId' in v ? '(connected account: reconnect in Elaichi)' : v]))
}

function original(step: PdStep | undefined, language: string): PlanItem['original'] {
  if (!step) return undefined
  if (step.code !== undefined) return { language, code: step.code }
  if (step.componentKey) return { component: `${step.componentKey}${step.componentVersion ? `@${step.componentVersion}` : ''}`, props: safeProps(step.props) }
  return undefined
}

export function workflowPlanItems(wf: PdWorkflow, report: WorkflowReport): PlanItem[] {
  const byNs = new Map([...wf.steps, ...wf.branches.flatMap(b => b.steps)].map(s => [s.namespace, s]))
  const file = report.output_file
  const items: PlanItem[] = []
  report.triggers.forEach((t, i) => {
    if (t.status === 'mapped') return
    items.push({ id: `${file}#trigger:${i}`, target: 'trigger', elaichi_keys: [], status: t.status, kinds: ['manual'], reasons: [`Pipedream ${t.source} → ${t.became}.`, ...t.notes], limits: t.limits ?? [] })
  })
  for (const s of report.steps) {
    if (s.status === 'mapped') continue
    const step = byNs.get(s.namespace)
    items.push({
      id: `${file}#${s.elaichi_keys[0] ?? s.namespace}`,
      target: 'step',
      pipedream_step: s.namespace,
      elaichi_keys: s.elaichi_keys,
      status: s.status,
      kinds: s.todo,
      reasons: s.notes,
      limits: s.limits,
      original: original(step, s.source.replace(/ code$/, '')),
    })
  }
  if (report.limits.length > 0) items.push({ id: `${file}#workflow`, target: 'workflow', elaichi_keys: [], status: 'needs_work', kinds: ['manual'], reasons: report.notes.filter(n => /allows (50|10)/.test(n)), limits: report.limits })
  return items
}

export function buildPlan(report: ProjectReport, workflows: { wf: PdWorkflow; report: WorkflowReport }[]): MigrationPlan {
  const used = new Set<LimitId>()
  const out = workflows.map(({ wf, report: wr }) => {
    const items = workflowPlanItems(wf, wr)
    items.forEach(i => i.limits.forEach(l => used.add(l)))
    return { name: wr.name, draft_file: wr.output_file, ...(wr.pipedream_id ? { pipedream_id: wr.pipedream_id } : {}), reconnect: wr.reconnect, secrets: wr.secrets, items }
  })
  return {
    schema: 'pipedream-to-elaichi/migration-plan@1',
    generated_at: report.generated_at,
    input: report.input,
    instructions: 'https://github.com/trutohq/pipedream-to-elaichi/blob/main/skills/migrate-pipedream-to-elaichi/SKILL.md',
    limits: Object.fromEntries([...used].sort().map(id => [id, LIMITS[id]])),
    workflows: out,
    not_converted: report.not_converted,
  }
}
