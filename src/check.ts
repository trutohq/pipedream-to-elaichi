import type { Definition, Step, Trigger } from './types.ts'

// A local copy of the parts of Elaichi's validator this importer can break: allowed fields per
// step and trigger type (the real schema is strict), key patterns, uniqueness and limits.
// It checks shape only. `elaichi__automation__draft__validate` (or POST /automation/validate)
// is the real check, and also resolves toolboxes, tools and JSONata.

const COMMON = ['key', 'type', 'name', 'description', 'run_if', 'error_handling', 'retry', 'timeout_seconds', 'repeat']
const STEP_FIELDS: Record<string, string[]> = {
  call_tool: [...COMMON, 'toolbox_id', 'tool', 'args', 'connection_id', 'money'],
  code: [...COMMON, 'language', 'source', 'input'],
  check: [...COMMON, 'assert', 'message', 'severity'],
  filter: [...COMMON, 'condition'],
  wait: [...COMMON, 'seconds', 'until'],
  approve: [...COMMON, 'title', 'message', 'message_format', 'details', 'approvers', 'prevent_self_approval', 'expires_after_seconds', 'on_expire', 'on_reject', 'escalate', 'notify', 'min_approvals', 'display_as'],
  'state.get': [...COMMON, 'keys'],
  'state.set': [...COMMON, 'state_key', 'value', 'cas'],
  branch: [...COMMON, 'branches', 'else'],
}
const REQUIRED: Record<string, string[]> = {
  call_tool: ['toolbox_id', 'tool'],
  code: ['language', 'source'],
  check: ['assert', 'message'],
  filter: ['condition'],
  wait: [],
  approve: ['title', 'approvers'],
  'state.get': ['keys'],
  'state.set': ['state_key', 'value'],
  branch: ['branches'],
}
const TRIGGER_FIELDS: Record<string, string[]> = {
  manual: ['key', 'type', 'overlap'],
  cron: ['key', 'type', 'cron', 'timezone', 'missed_runs', 'overlap'],
  webhook: ['key', 'type', 'auth', 'methods', 'dedupe_key', 'overlap'],
}

const STEP_KEY = /^[a-z][a-z0-9_]{0,63}$/
const STATE_KEY = /^[a-z][a-z0-9_.:-]{0,127}$/
const EXPRESSION_FIELDS = ['run_if', 'args', 'input', 'assert', 'message', 'condition', 'value', 'title', 'until', 'when']

/**
 * `strict` (what the importer writes): every step type must be one this file knows.
 * Not strict (a draft someone edited): other step and trigger types are passed over, so only
 * Elaichi's validator checks them.
 */
export function checkDefinition(def: Definition, opts: { strict?: boolean } = {}): string[] {
  const strict = opts.strict ?? true
  const issues: string[] = []
  const keys = new Set<string>()
  let total = 0
  let codeSteps = 0
  let approveSteps = 0

  const topAllowed = ['schema_version', 'triggers', 'toolboxes', 'steps', 'collections', 'knowledge_bases', 'input_schema', 'output', 'session_key', 'session_title', 'config_schema']
  if (!def || typeof def !== 'object') return ['definition: must be an object']
  if (!Array.isArray(def.triggers)) return ['definition: triggers must be a list']
  if (!Array.isArray(def.steps)) return ['definition: steps must be a list']
  for (const f of Object.keys(def)) if (!topAllowed.includes(f)) issues.push(`definition: unknown field "${f}"`)
  if (def.schema_version !== 1) issues.push('definition: schema_version must be 1')
  if (!Array.isArray(def.toolboxes)) issues.push('definition: toolboxes is required')
  else if (def.toolboxes.length > 10) issues.push(`definition: ${def.toolboxes.length} toolboxes; at most 10`)
  if (def.triggers.length < 1 || def.triggers.length > 5) issues.push(`definition: ${def.triggers.length} triggers; 1 to 5 allowed`)

  const tkeys = new Set<string>()
  def.triggers.forEach((t: Trigger, i) => {
    const allowed = TRIGGER_FIELDS[t.type]
    if (!allowed) return strict ? issues.push(`trigger ${i}: type "${t.type}" is not one this importer writes`) : undefined
    for (const f of Object.keys(t)) if (!allowed.includes(f)) issues.push(`trigger ${t.key}: unknown field "${f}"`)
    if (!t.key || t.key.length > 64) issues.push(`trigger ${i}: key must be 1 to 64 characters`)
    if (tkeys.has(t.key)) issues.push(`trigger ${t.key}: duplicate key`)
    tkeys.add(t.key)
    if (t.type === 'cron' && String(t.cron).trim().split(/\s+/).length !== 5) issues.push(`trigger ${t.key}: cron must have 5 fields`)
    if (t.type === 'webhook' && Array.isArray(t.methods) && t.methods.some(m => m !== 'POST' && m !== 'PUT')) issues.push(`trigger ${t.key}: methods must be POST or PUT`)
  })

  const walk = (steps: Step[], where: string) => {
    if (!Array.isArray(steps) || steps.length === 0) issues.push(`${where}: steps must be a non-empty list`)
    for (const s of steps) {
      total++
      const allowed = STEP_FIELDS[s.type]
      if (!allowed) {
        if (strict) issues.push(`step ${s.key}: type "${s.type}" is not one this importer writes`)
        else if (keys.has(s.key)) issues.push(`step ${s.key}: duplicate key`)
        keys.add(s.key)
        continue
      }
      for (const f of Object.keys(s)) if (!allowed.includes(f)) issues.push(`step ${s.key}: unknown field "${f}" for ${s.type}`)
      for (const f of REQUIRED[s.type] ?? []) if (s[f] === undefined) issues.push(`step ${s.key}: missing ${f}`)
      if (!STEP_KEY.test(s.key)) issues.push(`step ${s.key}: key must match ${STEP_KEY}`)
      if (keys.has(s.key)) issues.push(`step ${s.key}: duplicate key`)
      keys.add(s.key)
      if (s.name !== undefined && s.name.length > 120) issues.push(`step ${s.key}: name over 120 characters`)
      if (s.description !== undefined && s.description.length > 500) issues.push(`step ${s.key}: description over 500 characters`)
      for (const f of EXPRESSION_FIELDS) {
        const v = s[f]
        if (v !== undefined && (typeof v !== 'string' || v.length === 0 || v.length > 10000)) issues.push(`step ${s.key}: ${f} must be a JSONata string of 1 to 10,000 characters`)
      }
      if (s.type === 'call_tool' && typeof s.toolbox_id === 'string' && !def.toolboxes.includes(s.toolbox_id)) issues.push(`step ${s.key}: toolbox ${s.toolbox_id} is not listed in toolboxes`)
      if (s.type === 'code') {
        codeSteps++
        if (s.language !== 'javascript') issues.push(`step ${s.key}: language must be javascript`)
        if (typeof s.source !== 'string' || Buffer.byteLength(s.source) > 65536) issues.push(`step ${s.key}: source must be text of at most 64 KB`)
      }
      if (s.type === 'wait' && s.until === undefined && (typeof s.seconds !== 'number' || !Number.isInteger(s.seconds) || s.seconds < 1 || s.seconds > 3600)) issues.push(`step ${s.key}: wait seconds must be a whole number from 1 to 3600`)
      if (s.type === 'state.get' && (!Array.isArray(s.keys) || s.keys.some(k => typeof k !== 'string' || !STATE_KEY.test(k)))) issues.push(`step ${s.key}: state keys must match ${STATE_KEY}`)
      if (s.type === 'state.set' && (typeof s.state_key !== 'string' || !STATE_KEY.test(s.state_key))) issues.push(`step ${s.key}: state_key must match ${STATE_KEY}`)
      if (s.type === 'approve') {
        approveSteps++
        const exp = s.expires_after_seconds
        if (exp !== undefined && (typeof exp !== 'number' || exp < 300 || exp > 2592000)) issues.push(`step ${s.key}: expires_after_seconds must be 300 to 2,592,000`)
      }
      if (s.type === 'branch') {
        const arms = s.branches as { key: string; label?: string; when: string; steps: Step[] }[]
        for (const a of arms) {
          for (const f of Object.keys(a)) if (!['key', 'label', 'when', 'steps'].includes(f)) issues.push(`step ${s.key}: arm ${a.key} has unknown field "${f}"`)
          if (!STEP_KEY.test(a.key)) issues.push(`step ${s.key}: arm key ${a.key} must match ${STEP_KEY}`)
          walk(a.steps, `step ${s.key} arm ${a.key}`)
        }
        if (Array.isArray(s.else)) walk(s.else as Step[], `step ${s.key} else`)
      }
    }
  }
  walk(def.steps, 'definition')
  if (total > 50) issues.push(`definition: ${total} steps; at most 50`)
  if (codeSteps > 10) issues.push(`definition: ${codeSteps} code steps; at most 10`)
  if (approveSteps > 5) issues.push(`definition: ${approveSteps} approve steps; at most 5`)
  return issues
}

/** The import TODOs still open in a draft. The review gate (`import_review`) is reported on its own. */
export function findTodos(def: Definition): { todos: string[]; reviewGate: boolean } {
  const todos: string[] = []
  let reviewGate = false
  for (const id of def.toolboxes ?? []) if (id.startsWith('tbx_REPLACE_')) todos.push(`toolboxes: ${id} is a placeholder; put a real tbx_ id in its place`)
  const walk = (steps: Step[]) => {
    for (const s of steps ?? []) {
      // One line per step: the most specific reason it is still open.
      const open =
        s.key === 'import_review'
          ? undefined
          : s.type === 'check' && s.assert === 'false'
            ? `TODO step "${s.name ?? ''}" still holds a Pipedream step's place`
            : s.type === 'code' && typeof s.source === 'string' && /throw new Error\("TODO: port/.test(s.source)
              ? 'code not ported yet'
              : s.type === 'call_tool' && typeof s.toolbox_id === 'string' && s.toolbox_id.startsWith('tbx_REPLACE_')
                ? 'toolbox_id is a placeholder'
                : typeof s.name === 'string' && s.name.startsWith('TODO:')
                  ? `name still starts with TODO ("${s.name}")`
                  : typeof s.description === 'string' && s.description.startsWith('TODO:')
                    ? `still marked TODO: ${s.description.slice(6, 160)}${s.description.length > 160 ? '…' : ''} (rewrite the description once it is fixed)`
                    : undefined
      if (s.key === 'import_review') reviewGate = true
      if (open) todos.push(`step ${s.key}: ${open}`)
      if (Array.isArray(s.branches)) for (const a of s.branches as { key: string; when: string; steps: Step[] }[]) {
        if (a.when === 'false') todos.push(`step ${s.key}: arm ${a.key} is switched off (when "false")`)
        walk(a.steps)
      }
      if (Array.isArray(s.else)) walk(s.else as Step[])
    }
  }
  walk(def.steps)
  return { todos, reviewGate }
}
