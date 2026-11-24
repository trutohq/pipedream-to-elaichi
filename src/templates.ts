// Pipedream props hold `{{ ... }}` templates, and inside them any JavaScript expression.
// Elaichi reads JSONata. Only plain paths are rewritten (`steps.x.$return_value.a["b"][0]`,
// `steps.trigger.event.body.email`); anything else is reported, never guessed.

export type RefKind = 'code' | 'action' | 'state_get' | 'other'

export interface StepRef {
  key: string
  kind: RefKind
  /** For a state.get step: the state key it reads. */
  stateKey?: string
}

export interface RefContext {
  /** Pipedream namespace → the Elaichi step that now holds its result. Only earlier steps. */
  steps: Map<string, StepRef>
  /** `steps.trigger.event` is `trigger.payload` only for a webhook (HTTP) trigger. */
  triggerIsHttp: boolean
}

export interface Converted {
  expr: string
  problems: string[]
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

type Seg = { kind: 'name'; value: string } | { kind: 'index'; value: number }

function tokenize(path: string): Seg[] | null {
  const segs: Seg[] = []
  let rest = path
  const first = /^([A-Za-z_$][\w$]*)/.exec(rest)
  if (!first?.[1]) return null
  segs.push({ kind: 'name', value: first[1] })
  rest = rest.slice(first[1].length)
  while (rest.length > 0) {
    let m: RegExpExecArray | null
    if ((m = /^\.([A-Za-z_$][\w$]*)/.exec(rest)) && m[1]) segs.push({ kind: 'name', value: m[1] })
    else if ((m = /^\[\s*"((?:[^"\\]|\\.)*)"\s*\]/.exec(rest)) && m[1] !== undefined) segs.push({ kind: 'name', value: JSON.parse(`"${m[1]}"`) as string })
    else if ((m = /^\[\s*'((?:[^'\\]|\\.)*)'\s*\]/.exec(rest)) && m[1] !== undefined) segs.push({ kind: 'name', value: m[1].replace(/\\(.)/g, '$1') })
    else if ((m = /^\[\s*(\d+)\s*\]/.exec(rest)) && m[1]) segs.push({ kind: 'index', value: Number(m[1]) })
    else return null
    rest = rest.slice(m[0].length)
  }
  return segs
}

function renderSegs(segs: Seg[]): string | null {
  let out = ''
  for (const s of segs) {
    if (s.kind === 'index') out += `[${s.value}]`
    else if (IDENT.test(s.value)) out += `.${s.value}`
    else if (s.value.includes('`')) return null
    else out += `.\`${s.value}\``
  }
  return out
}

// JavaScript properties that JSONata would read as a field name instead.
const JS_MEMBERS = new Set(['length', 'size', 'constructor', 'prototype'])
const jsMember = (segs: Seg[]) => segs.some(s => s.kind === 'name' && JS_MEMBERS.has(s.value))
const jsProblem = (text: string) => `"{{${text}}}" uses a JavaScript property: rewrite it as JSONata (for example $count() for an array or $length() for a string)`

/** One `{{ path }}` body → JSONata, or a reason it cannot be rewritten. */
export function pathToJsonata(inner: string, ctx: RefContext): { expr?: string; problem?: string; note?: string } {
  const text = inner.trim()
  const segs = tokenize(text)
  const plain = `"{{${text}}}" is JavaScript, not a plain path: rewrite it as JSONata`
  if (!segs || segs[0]?.kind !== 'name' || segs[0].value !== 'steps') return { problem: plain }
  const ns = segs[1]
  if (!ns || ns.kind !== 'name') return { problem: plain }

  if (ns.value === 'trigger') {
    const ev = segs[2]
    if (!ev || ev.kind !== 'name' || ev.value !== 'event') return { problem: `"{{${text}}}" reads trigger data other than the event: rewrite it` }
    const rest = renderSegs(segs.slice(3))
    if (rest === null) return { problem: plain }
    if (jsMember(segs.slice(3))) return { problem: jsProblem(text) }
    if (!ctx.triggerIsHttp) return { expr: `trigger.payload${rest}`, problem: `"{{${text}}}" reads the trigger event, which has a different shape in Elaichi for this trigger: check it in a dry run` }
    return { expr: `trigger.payload${rest}`, note: 'Pipedream HTTP event fields body, headers, query and method are in trigger.payload; path and url are not.' }
  }

  const ref = ctx.steps.get(ns.value)
  if (!ref) return { problem: `"{{${text}}}" reads step "${ns.value}", which is not an earlier step here` }
  const field = segs[2]
  if (!field || field.kind !== 'name' || field.value !== '$return_value') {
    return { problem: `"{{${text}}}" reads a $.export value of "${ns.value}": return it from that step instead, then read steps.${ref.key}` }
  }
  const rest = renderSegs(segs.slice(3))
  if (rest === null) return { problem: plain }
  if (jsMember(segs.slice(3))) return { problem: jsProblem(text) }
  switch (ref.kind) {
    case 'code':
      return { expr: `steps.${ref.key}${rest}` }
    case 'action':
      return { expr: `steps.${ref.key}.result${rest}`, note: `"${ns.value}" is now an Elaichi tool call: its result may be shaped differently from Pipedream's, so check it in a dry run.` }
    case 'state_get':
      return { expr: `steps.${ref.key}.\`${ref.stateKey}\`${rest}` }
    default:
      return { problem: `"{{${text}}}" reads step "${ns.value}", which was not converted to an Elaichi step with a result` }
  }
}

const TEMPLATE = /\{\{([\s\S]*?)\}\}/g

/** Any configured prop value → a JSONata expression string. Literal text is quoted; objects and arrays become constructors. */
export function valueToJsonata(value: unknown, ctx: RefContext, notes?: Set<string>): Converted {
  const problems: string[] = []
  const expr = convert(value, ctx, problems, notes)
  return { expr, problems }
}

function convert(value: unknown, ctx: RefContext, problems: string[], notes?: Set<string>): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(v => convert(v, ctx, problems, notes)).join(', ')}]`
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${convert(v, ctx, problems, notes)}`)
    return `{${parts.join(', ')}}`
  }
  const s = String(value)
  const pieces: string[] = []
  let last = 0
  let onlyTemplate = false
  for (const m of s.matchAll(TEMPLATE)) {
    const start = m.index ?? 0
    if (start > last) pieces.push(JSON.stringify(s.slice(last, start)))
    const r = pathToJsonata(m[1] ?? '', ctx)
    if (r.problem) problems.push(r.problem)
    if (r.note) notes?.add(r.note)
    // An unconvertible template stays visible as text, so a dry run shows it instead of an empty value.
    pieces.push(r.expr ? `$string(${r.expr})` : JSON.stringify(m[0]))
    onlyTemplate = start === 0 && m[0].length === s.length && r.expr !== undefined
    if (onlyTemplate) return r.expr as string // keep the value's own type (object, number)
    last = start + m[0].length
  }
  if (pieces.length === 0) return JSON.stringify(s)
  if (last < s.length) pieces.push(JSON.stringify(s.slice(last)))
  return pieces.join(' & ')
}
