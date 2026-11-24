import { appOf, findTool, NO_ELAICHI_CONNECTOR } from './catalog.ts'
import { analyzeNode, languageOf, nodeShim, placeholderSource } from './code.ts'
import { isObj, type Obj, type PdStep, type PdTrigger, type PdWorkflow } from './parse.ts'
import { valueToJsonata, type RefContext, type StepRef } from './templates.ts'
import type { Definition, DraftBody, Status, Step, StepReport, Trigger, TriggerReport, WorkflowReport } from './types.ts'

export interface ConvertOptions {
  /** Elaichi connector slug → stored toolbox id (`tbx_…`) to put in call_tool steps. */
  toolboxes?: Record<string, string>
  /** Warnings manifest.json lists for this workflow. */
  manifestWarnings?: string[]
  outputFile?: string
}

export const MAX_WAIT_SECONDS = 3600
const MAX_CODE_SOURCE_BYTES = 65536
const MAX_EXPRESSION = 10000

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const quote = (s: string) => JSON.stringify(s)

/** Hands out unique step keys matching `^[a-z][a-z0-9_]{0,63}$`. */
class Keys {
  private used = new Set<string>()
  take(wanted: string): string {
    let base = wanted
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!/^[a-z]/.test(base)) base = `s_${base}`
    base = base.slice(0, 56) || 's'
    let key = base
    for (let n = 2; this.used.has(key); n++) key = `${base}_${n}`
    this.used.add(key)
    return key
  }
}

/** State keys must match `^[a-z][a-z0-9_.:-]{0,127}$`. */
function stateKey(store: string, key: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_')
  let k = `${clean(store)}:${clean(key)}`
  if (!/^[a-z]/.test(k)) k = `ds_${k}`
  return k.slice(0, 128)
}

interface PropScan {
  values: Obj
  reconnect: string[]
  secrets: string[]
}

/** Unwraps `{ __lv: { label, value } }`, drops connected accounts and lists redacted secrets. */
function scanProps(props: Obj, label: string): PropScan {
  const values: Obj = {}
  const reconnect: string[] = []
  const secrets: string[] = []
  for (const [name, v] of Object.entries(props)) {
    if (isObj(v) && 'authProvisionId' in v) {
      reconnect.push(name)
      continue
    }
    if (v === '<redacted>') {
      secrets.push(`${label}: ${name}`)
      continue
    }
    values[name] = unwrapLv(v)
  }
  return { values, reconnect, secrets }
}

function unwrapLv(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapLv)
  if (isObj(v)) {
    if (isObj(v.__lv) && 'value' in v.__lv) return unwrapLv(v.__lv.value)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrapLv(x)]))
  }
  return v
}

interface Ctx {
  keys: Keys
  refs: RefContext
  opts: ConvertOptions
  toolboxes: Set<string>
  reconnect: Set<string>
  secrets: Set<string>
  codeSteps: number
}

/** A step that holds an unconvertible step's place and fails the run until someone replaces it. */
function todoStep(key: string, namespace: string, what: string): Step {
  return {
    key,
    type: 'check',
    name: clip(`TODO: ${namespace}`, 120),
    description: clip(what, 500),
    assert: 'false',
    message: quote(clip(`TODO (from Pipedream step "${namespace}"): ${what}`, 4000)),
    severity: 'fail',
  }
}

function describe(base: string, notes: string[]): string {
  return clip(notes.length > 0 ? `TODO: ${notes[0]} ${base}` : base, 500)
}

function convertStep(step: PdStep, ctx: Ctx, branch?: string): { steps: Step[]; report: StepReport; ref?: StepRef } {
  const notes: string[] = []
  const out: Step[] = []
  let status: Status = 'mapped'
  let became = ''
  let ref: StepRef | undefined
  const label = step.namespace
  const scan = scanProps(step.props, label)
  scan.secrets.forEach(s => ctx.secrets.add(s))
  const source = step.code !== undefined
    ? `${languageOf(step.runtime, step.code).name} code`
    : step.componentKey
      ? `action ${step.componentKey}${step.componentVersion ? `@${step.componentVersion}` : ''}`
      : step.codePath
        ? `code in ${step.codePath}`
        : 'unrecognized step'
  const needs = (note: string) => {
    notes.push(note)
    if (status === 'mapped') status = 'needs_work'
  }
  if (scan.secrets.length > 0) needs(`Re-enter the redacted secret ${scan.secrets.length === 1 ? 'prop' : 'props'} ${scan.secrets.map(s => s.split(': ')[1]).join(', ')}.`)

  if (step.code !== undefined) {
    scan.reconnect.forEach(r => ctx.reconnect.add(r))
    if (scan.reconnect.length > 0) needs(`Used connected account${scan.reconnect.length === 1 ? '' : 's'} ${scan.reconnect.join(', ')} in code; Elaichi code never sees credentials. Move those calls to call_tool steps.`)
    const lang = languageOf(step.runtime, step.code)
    const key = ctx.keys.take(step.namespace)
    ctx.codeSteps++
    if (lang.name !== 'Node.js') {
      out.push({ key, type: 'code', name: clip(`TODO: port ${step.namespace} (${lang.name})`, 120), description: clip(`Was a ${lang.name} step in Pipedream. The original is kept in a comment; port it to JavaScript.`, 500), language: 'javascript', source: placeholderSource(step.code, lang.name, step.namespace) })
      became = 'code step that fails until ported'
      needs(`${lang.name} step: Elaichi code steps run JavaScript only. Port it; the original is in the step's source.`)
      ref = { key, kind: 'code' }
    } else {
      const a = analyzeNode(step.code)
      const source = nodeShim(step.code, step.namespace)
      // input: earlier results under their Pipedream names, and the configured props.
      const parts: string[] = []
      const readable = a.stepsRead === null ? [...ctx.refs.steps.keys(), 'trigger'] : a.stepsRead
      if (readable.includes('trigger')) parts.push(`"trigger": {"event": trigger.payload}`)
      for (const ns of readable) {
        const r = ctx.refs.steps.get(ns)
        if (!r || ns === 'trigger') continue
        const expr = r.kind === 'action' ? `steps.${r.key}.result` : r.kind === 'state_get' ? `steps.${r.key}.\`${r.stateKey}\`` : `steps.${r.key}`
        parts.push(`${quote(ns)}: {"$return_value": ${expr}}`)
      }
      for (const ns of readable) if (ns !== 'trigger' && !ctx.refs.steps.has(ns)) needs(`Reads steps.${ns}, which is not an earlier converted step.`)
      const noteSet = new Set<string>()
      const propsConv = valueToJsonata(scan.values, ctx.refs, noteSet)
      propsConv.problems.forEach(needs)
      const input = `{"steps": {${parts.join(', ')}}, "props": ${propsConv.expr}}`
      if (input.length > MAX_EXPRESSION) needs('The step input expression is over 10,000 characters: pass fewer earlier results.')

      if (!a.hasComponent) needs('No `export default defineComponent(...)` found: wrap the code so it returns its result.')
      if (a.imports.length > 0) needs(`Uses npm packages (${a.imports.join(', ')}); Elaichi code cannot load packages. The imports are commented out.`)
      if (a.network.length > 0) needs(`Makes network calls (${a.network.join(', ')}); Elaichi code has no network. Move each call to a call_tool step with a connected app.`)
      if (a.usesAuth) needs('Reads connected-account credentials ($auth); Elaichi code never sees credentials. Use a call_tool step.')
      if (a.usesEnv) needs('Reads process.env; environment variables are not exported and Elaichi code has none. Pass the values in the step input or a workflow setting.')
      if (a.dataStoreProps.length > 0) needs(`Uses a data store (${a.dataStoreProps.join(', ')}); Elaichi code cannot read state. Add state.get before and state.set after this step, or use a collection.`)
      if (a.usesExport) needs('Uses $.export; only the return value is passed on in Elaichi. Return everything later steps read.')
      if (a.usesRespond) needs('Calls $.respond; Elaichi answers webhooks with 202 itself and a workflow cannot set the HTTP response. Remove it.')
      if (a.usesRerun) needs('Calls $.flow.rerun; use a step retry or a repeat policy instead.')
      if (a.usesFiles) needs('Uses /tmp or File Store files; Elaichi code has no file system. Use parse/file.write steps or a connected storage app.')
      if (Buffer.byteLength(source) > MAX_CODE_SOURCE_BYTES) needs('The code is over 64 KB, the most an Elaichi code step holds: split it.')

      out.push({ key, type: 'code', name: clip(step.namespace, 120), description: describe('Pipedream Node.js step, wrapped to run as-is. Check it in a dry run.', notes), language: 'javascript', source, input })
      became = 'code step'
      ref = { key, kind: 'code' }

      if (a.usesExit) {
        const fk = ctx.keys.take(`${key}_exit`)
        out.push({ key: fk, type: 'filter', name: clip(`Stop if ${step.namespace} ended the workflow`, 120), description: 'Replaces $.flow.exit(): when the step above called it, the steps after this one are skipped.', condition: `$not(steps.${key}.__pd_flow_exit = true)` })
        became += ' + filter ($.flow.exit)'
      }
      for (const d of a.delays) {
        const wk = ctx.keys.take(`${key}_delay`)
        let seconds = d.ms === null ? 60 : Math.max(1, Math.round(d.ms / 1000))
        if (d.ms === null) needs(`${d.text} has no literal duration; the wait step is set to 60 seconds. Set the real value.`)
        else if (seconds > MAX_WAIT_SECONDS) {
          needs(`${d.text} waits ${Math.round(seconds / 60)} minutes; an Elaichi wait is at most 1 hour. Split the workflow (a schedule_once trigger or a cron that checks state).`)
          seconds = MAX_WAIT_SECONDS
        }
        out.push({ key: wk, type: 'wait', name: clip(`Wait (from ${step.namespace})`, 120), description: clip(`Replaces ${d.text}. Pipedream paused only when the code reached that call; if it was inside an if, add a run_if here.`, 500), seconds })
        became += ' + wait'
      }
      for (const s of a.suspends) {
        const ak = ctx.keys.take(`${key}_approval`)
        const approve: Step = {
          key: ak,
          type: 'approve',
          name: clip(`Approve (from ${step.namespace})`, 120),
          description: 'Replaces $.flow.suspend(). Pipedream resumed when someone opened resume_url; Elaichi asks the approvers instead.',
          title: quote(clip(`Continue "${step.namespace}"?`, 200)),
          approvers: { include_owner: true },
          on_reject: 'stop',
          on_expire: 'fail',
        }
        if (s.timeoutMs !== null) approve.expires_after_seconds = Math.min(2592000, Math.max(300, Math.round(s.timeoutMs / 1000)))
        out.push(approve)
        became += ' + approve'
        if (a.usesResumeUrl) needs('The code sends resume_url/cancel_url somewhere. Elaichi has no resume link: approvers answer in Elaichi or Slack. Remove that code, and add approvers beyond the owner if needed.')
      }
    }
  } else if (step.componentKey) {
    const k = step.componentKey
    const app = appOf(k)
    const known = findTool(k)
    if (scan.reconnect.length > 0) ctx.reconnect.add(known ? known.slug : NO_ELAICHI_CONNECTOR[app] ? `${app} (no Elaichi connector)` : app)
    const noteSet = new Set<string>()

    if (k.startsWith('data_stores-')) {
      const keyVal = scan.values.key
      const store = String(isObj(step.props.dataStore) && isObj(step.props.dataStore.__lv) ? (step.props.dataStore.__lv.label ?? 'store') : 'store')
      const literal = typeof keyVal === 'string' && !keyVal.includes('{{') ? keyVal : undefined
      const key = ctx.keys.take(step.namespace)
      if (literal && (k === 'data_stores-get-record' || k === 'data_stores-get-record-or-create')) {
        const sk = stateKey(store, literal)
        out.push({ key, type: 'state.get', name: clip(step.namespace, 120), description: clip(`Reads "${literal}" from workflow state (was data store "${store}").`, 500), keys: [sk] })
        ref = { key, kind: 'state_get', stateKey: sk }
        became = `state.get ${sk}`
        notes.push(`Data store contents are not in the export: put the current value into state (or a collection) before you turn this on.`)
        if (k === 'data_stores-get-record-or-create') needs('Pipedream created the record when it was missing; state.get returns nothing instead. Add a default where it is read.')
      } else if (literal && k === 'data_stores-add-update-record') {
        const sk = stateKey(store, literal)
        const conv = valueToJsonata(scan.values.value ?? null, ctx.refs, noteSet)
        conv.problems.forEach(needs)
        out.push({ key, type: 'state.set', name: clip(step.namespace, 120), description: describe(`Writes "${literal}" to workflow state (was data store "${store}").`, notes), state_key: sk, value: conv.expr })
        ref = { key, kind: 'other' }
        became = `state.set ${sk}`
        if (scan.values.ttl !== undefined) needs('The record had a TTL; Elaichi state does not expire.')
      } else {
        const why = keyVal === undefined ? '' : literal ? '' : ' with a key computed at run time'
        out.push(todoStep(key, step.namespace, `Pipedream data store action ${k}${why}. Use Elaichi state (fixed keys) or a collection (create one, then use collection.upsert / collection.query).`))
        became = 'TODO step'
        status = 'needs_work'
        notes.push('No automatic mapping: use state (fixed keys) or a collection.')
      }
      if (literal && stateKey(store, literal).split(':')[1] !== literal) notes.push(`State keys are lower case with no spaces: "${literal}" became "${stateKey(store, literal)}".`)
      notes.push('Elaichi state belongs to one workflow; a Pipedream data store could be shared. If other workflows use the same store, use a collection.')
    } else if (k === 'http-return-http-response' || k.startsWith('http-return-')) {
      const key = ctx.keys.take(step.namespace)
      out.push(todoStep(key, step.namespace, 'Returned an HTTP response. Elaichi answers webhooks with 202 at once and a workflow cannot set the response. Delete this step; if the caller needs data back, send it with a tool call instead.'))
      became = 'TODO step (delete it)'
      needs('Elaichi always answers 202: delete this step.')
    } else if (app === 'http' || k === 'pipedream-send-http-request') {
      const key = ctx.keys.take(step.namespace)
      out.push(todoStep(key, step.namespace, `Made an HTTP request (${k}). Elaichi workflows cannot call arbitrary URLs: use a tool from a connected app, or a custom connector.`))
      became = 'TODO step'
      status = 'no_match'
      notes.push('No web requests in Elaichi workflows: use a connected app\'s tool.')
    } else {
      const m = findTool(k)
      if (!m) {
        const key = ctx.keys.take(step.namespace)
        const none = NO_ELAICHI_CONNECTOR[app]
        const reason = none
          ? `Elaichi has no ${none} connector (checked 2026-11-24).`
          : k.startsWith('@')
            ? `${k} is a private component; its code is not in the export.`
            : `${k} is not in this importer's table. Elaichi may still have a connector for "${app}": search the connector catalog.`
        out.push(todoStep(key, step.namespace, `${reason} Configured props: ${clip(JSON.stringify(scan.values), 300)}`))
        became = 'TODO step'
        status = 'no_match'
        notes.push(reason)
      } else {
        const key = ctx.keys.take(step.namespace)
        const given = ctx.opts.toolboxes?.[m.slug]
        const toolbox = given ?? `tbx_REPLACE_${m.slug.replace(/[^a-z0-9]+/gi, '_')}`
        ctx.toolboxes.add(toolbox)
        const callStep: Step = { key, type: 'call_tool', name: clip(step.namespace, 120), description: '', toolbox_id: toolbox, tool: m.tool }
        if (!given) needs(`Create a toolbox with ${m.slug}'s ${m.tool} tool and put its tbx_ id here (or pass --toolbox ${m.slug}=tbx_…).`)
        const mapped = m.args?.(scan.values) ?? null
        if (mapped) {
          const conv = valueToJsonata(mapped, ctx.refs, noteSet)
          conv.problems.forEach(needs)
          callStep.args = conv.expr
          const unused = Object.entries(scan.values).filter(([name, v]) => !(m.argProps ?? []).includes(name) && v !== undefined && v !== null && v !== '')
          if (unused.length > 0) needs(`These Pipedream props were not carried over: ${clip(unused.map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(', '), 300)}. Add the matching ${m.tool} arguments by hand.`)
        } else {
          needs(`Write the tool arguments. Pipedream had: ${clip(JSON.stringify(scan.values), 300)}`)
        }
        if (m.unverified) needs(`Check this mapping: ${m.note ?? ''}`.trim())
        else if (m.note) notes.push(m.note)
        noteSet.forEach(n => notes.push(n))
        callStep.description = describe(`Was Pipedream action ${k}.`, notes.filter(n => n !== m.note))
        out.push(callStep)
        became = `call_tool ${m.slug}.${m.tool}`
        ref = { key, kind: 'action' }
      }
    }
  } else if (step.codePath) {
    const key = ctx.keys.take(step.namespace)
    out.push(todoStep(key, step.namespace, `Its code was in a separate file (${step.codePath}) and is not in this export. Paste it into a code step.`))
    became = 'TODO step'
    needs('Code not in the export file.')
  } else {
    const key = ctx.keys.take(step.namespace)
    out.push(todoStep(key, step.namespace, `This importer did not recognize the step's shape (fields: ${step.rawKeys.join(', ') || 'none'}). Rebuild it by hand.`))
    became = 'TODO step'
    status = 'no_match'
    notes.push(`Unrecognized step shape (fields: ${step.rawKeys.join(', ') || 'none'}).`)
  }

  if (step.disabled) {
    for (const s of out) s.run_if = 'false'
    notes.push('Disabled in Pipedream: kept, switched off with run_if "false".')
  }
  return {
    steps: out,
    report: { namespace: step.namespace, source, elaichi_keys: out.map(s => s.key), became, status, notes, ...(branch ? { branch } : {}) },
    ref,
  }
}

const TZ_OK = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$/

function intervalToCron(seconds: number): { cron: string; exact: boolean } {
  const s = Math.max(300, seconds)
  if (s % 86400 === 0 && s === 86400) return { cron: '0 0 * * *', exact: seconds === s }
  if (s % 3600 === 0 && 24 % (s / 3600) === 0) return { cron: s === 3600 ? '0 * * * *' : `0 */${s / 3600} * * *`, exact: seconds === s }
  if (s % 60 === 0 && 60 % (s / 60) === 0) return { cron: `*/${s / 60} * * * *`, exact: seconds === s }
  return { cron: '0 * * * *', exact: false }
}

/** The minutes a cron minute field fires on (star, a, a-b, star-slash-n, a-b/n, a/n, comma lists), or null. */
export function minutesOf(field: string): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!m?.[1]) return null
    const step = m[2] ? Number(m[2]) : 1
    let lo = 0
    let hi = 59
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number)
      lo = a ?? 0
      hi = b ?? (m[2] ? 59 : lo)
    }
    if (step < 1 || lo > hi || hi > 59) return null
    for (let i = lo; i <= hi; i += step) out.add(i)
  }
  return [...out].sort((a, b) => a - b)
}

/** Smallest gap in minutes between two runs. */
export function minGap(minutes: number[], wraps: boolean): number {
  let gap = 60
  for (let i = 1; i < minutes.length; i++) gap = Math.min(gap, (minutes[i] ?? 0) - (minutes[i - 1] ?? 0))
  const first = minutes[0]
  const last = minutes[minutes.length - 1]
  if (wraps && minutes.length > 1 && first !== undefined && last !== undefined) gap = Math.min(gap, 60 - last + first)
  return gap
}

/** Drops minutes until every two runs are at least 5 minutes apart. */
function thin(minutes: number[], wraps: boolean): number[] {
  const kept: number[] = []
  for (const m of minutes) if (kept.length === 0 || m - (kept[kept.length - 1] ?? 0) >= 5) kept.push(m)
  while (wraps && kept.length > 1 && 60 - (kept[kept.length - 1] ?? 0) + (kept[0] ?? 0) < 5) kept.pop()
  return kept
}

const TRIGGER_PROPS_READ: Record<string, string[]> = {
  timer: ['cron', 'timezone', 'interval_seconds', 'intervalSeconds', 'timer'],
  http: ['method', 'response', 'responseType'],
}

function convertTriggers(triggers: PdTrigger[], keys: Keys): { triggers: Trigger[]; reports: TriggerReport[]; http: boolean } {
  const out: Trigger[] = []
  const reports: TriggerReport[] = []
  let http = false
  let webhooks = 0
  let crons = 0
  for (const t of triggers) {
    const notes: string[] = []
    const kind = t.type === 'schedule' || t.type === 'cron' ? 'timer' : t.type === 'webhook' ? 'http' : t.type
    if (t.disabled) {
      reports.push({ source: `${kind} trigger`, became: 'nothing', status: 'needs_work', notes: ['Disabled in Pipedream, so it was not added. Add it in the console if you want it.'] })
      continue
    }
    const read = TRIGGER_PROPS_READ[kind]
    if (read) {
      const unread = Object.entries(t.props).filter(([n]) => !read.includes(n))
      if (unread.length > 0) notes.push(`Trigger settings not carried over: ${clip(unread.map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(', '), 300)}.`)
    }
    if (t.type === 'timer' || t.type === 'schedule' || t.type === 'cron') {
      let cron = t.cron
      let status: Status = 'mapped'
      if (cron) {
        const fields = cron.trim().split(/\s+/)
        if (fields.length !== 5) {
          notes.push(`"${cron}" is not a 5-field cron; Elaichi needs one. Set it by hand.`)
          status = 'needs_work'
        } else {
          const minute = fields[0] ?? ''
          const wraps = !/^\d+$/.test(fields[1] ?? '*') // runs in more than one hour, so minute 58 and minute 0 can be 2 minutes apart
          const minutes = minutesOf(minute)
          if (!minutes) {
            notes.push(`Could not read the minute field "${minute}". Elaichi needs runs at least 5 minutes apart: check it.`)
            status = 'needs_work'
          } else if (minGap(minutes, wraps) < 5) {
            fields[0] = /^\*(\/\d+)?$/.test(minute) ? '*/5' : thin(minutes, wraps).join(',')
            notes.push(`Ran more often than every 5 minutes ("${cron}"); Elaichi's limit is every 5 minutes, so it is now "${fields.join(' ')}".`)
            status = 'needs_work'
            cron = fields.join(' ')
          }
        }
      } else if (t.intervalSeconds !== undefined) {
        const r = intervalToCron(t.intervalSeconds)
        cron = r.cron
        if (!r.exact) {
          notes.push(`Ran every ${t.intervalSeconds} seconds; the nearest Elaichi schedule here is "${r.cron}". Check it.`)
          status = 'needs_work'
        } else notes.push(`Ran every ${t.intervalSeconds} seconds, counted from when it was deployed; now the cron "${r.cron}", on the clock.`)
        if (r.cron === '0 0 * * *') status = 'needs_work'
      }
      if (!cron || crons >= 3) {
        notes.push(crons >= 3 ? 'Elaichi allows at most 3 schedules per workflow.' : 'No schedule found in the export. Add a cron trigger by hand.')
        reports.push({ source: 'timer', became: 'nothing (see note)', status: 'needs_work', notes })
        continue
      }
      let timezone = t.timezone
      const hour = cron.trim().split(/\s+/)[1] ?? '*'
      const fixedHour = !/^\*(\/\d+)?$/.test(hour)
      if (!timezone || !TZ_OK.test(timezone)) {
        timezone = 'UTC'
        if (t.timezone) {
          notes.push(`Time zone "${t.timezone}" is not an IANA name; set to UTC.`)
          status = 'needs_work'
        } else if (fixedHour) {
          notes.push('No time zone in the export; set to UTC. Change it if the schedule meant local time.')
          status = 'needs_work'
        }
      }
      if (notes.some(n => n.startsWith('Trigger settings not carried over'))) status = 'needs_work'
      crons++
      out.push({ key: keys.take('schedule'), type: 'cron', cron, timezone })
      reports.push({ source: `timer${t.cron ? ` "${t.cron}"` : ''}`, became: `cron "${cron}" (${timezone})`, status, notes })
    } else if (t.type === 'http' || t.type === 'webhook') {
      http = true
      if (webhooks >= 3) {
        reports.push({ source: 'http', became: 'nothing', status: 'needs_work', notes: ['Elaichi allows at most 3 webhook triggers per workflow.'] })
        continue
      }
      webhooks++
      const method = typeof t.props.method === 'string' ? t.props.method.toUpperCase() : undefined
      notes.push('New URL and token: copy them from the workflow\'s Triggers panel after you save, and update every sender. Elaichi answers 202 at once; a workflow cannot set the HTTP response.')
      let status: Status = 'needs_work'
      const methods = method === 'PUT' ? ['PUT'] : ['POST']
      if (method && method !== 'POST' && method !== 'PUT') notes.push(`Pipedream took ${method} requests; Elaichi webhooks take POST or PUT only.`)
      if (t.props.response !== undefined || t.props.responseType !== undefined) notes.push('The trigger had a custom HTTP response; Elaichi cannot send one.')
      out.push({ key: keys.take('webhook'), type: 'webhook', auth: { scheme: 'token' }, methods })
      reports.push({ source: 'http', became: 'webhook (token auth)', status, notes })
    } else {
      const what = t.type === 'source' ? `app event source${t.sourceKey ? ` ${t.sourceKey}` : ''}` : t.type === 'email' ? 'email trigger' : t.type === 'form' ? 'form trigger' : `${t.type} trigger`
      const hint =
        t.type === 'email'
          ? 'Elaichi has no email trigger: have the mail forwarded to a service that posts to a webhook trigger, or read a mailbox (for example Gmail) on a cron schedule.'
          : t.type === 'form'
            ? 'Elaichi has no form trigger: post the form to a webhook trigger, or run it by hand with run inputs (input_schema).'
            : t.type === 'source' && t.sourceKey?.startsWith('slack')
              ? 'Elaichi has a Slack trigger (message or reaction in fixed channels): add it in the console.'
              : 'Elaichi has no trigger for an event inside a connected app: point the app\'s own webhook at a webhook trigger, or poll it on a cron schedule.'
      notes.push(hint)
      reports.push({ source: what, became: 'manual trigger (placeholder)', status: 'no_match', notes })
    }
  }
  if (!out.some(t => t.type === 'manual') && out.length < 5) out.push({ key: keys.take('manual'), type: 'manual' })
  return { triggers: out, reports, http }
}

export function convertWorkflow(wf: PdWorkflow, opts: ConvertOptions = {}): { draft: DraftBody; report: WorkflowReport } {
  const keys = new Keys()
  keys.take('import_review') // reserved for the review gate
  const { triggers, reports: triggerReports, http } = convertTriggers(wf.triggers, keys)
  const ctx: Ctx = {
    keys,
    refs: { steps: new Map(), triggerIsHttp: http },
    opts,
    toolboxes: new Set(),
    reconnect: new Set(),
    secrets: new Set(),
    codeSteps: 0,
  }
  const steps: Step[] = []
  const stepReports: StepReport[] = []
  for (const s of wf.steps) {
    const r = convertStep(s, ctx)
    steps.push(...r.steps)
    stepReports.push(r.report)
    if (r.ref) ctx.refs.steps.set(s.namespace, r.ref)
  }

  const notes: string[] = []
  if (wf.branches.length > 0) {
    const bk = keys.take('control_flow')
    const arms = wf.branches.map(b => {
      const inner: Step[] = []
      for (const s of b.steps) {
        const r = convertStep(s, ctx, b.id)
        inner.push(...r.steps)
        r.report.notes.push(`Inside Pipedream branch ${b.id}, which is switched off until you write its condition.`)
        stepReports.push(r.report)
        // Steps inside a branch are not visible to later steps outside it.
      }
      return { key: keys.take(`arm_${b.id}`), label: clip(`Pipedream branch ${b.id}`, 120), when: 'false', steps: inner }
    })
    steps.push({ key: bk, type: 'branch', name: 'TODO: rebuild control flow', description: 'Steps that sat inside Pipedream if/else or switch branches. Pipedream does not export where the branch sat or its condition: move this step, write each arm\'s when, then test.', branches: arms })
    stepReports.push({
      namespace: '(control flow)',
      source: 'deployments',
      elaichi_keys: [bk],
      became: 'branch step, every arm switched off',
      status: 'needs_work',
      notes: [`${wf.branches.length} control-flow branch${wf.branches.length === 1 ? '' : 'es'} came over as one branch step at the end with every arm switched off (when "false"). The export does not say where each branch sat or its condition: move the step and write each arm's when.`],
    })
  }
  if (wf.deploymentsUnread) {
    stepReports.push({
      namespace: '(control flow)',
      source: 'deployments',
      elaichi_keys: [],
      became: 'nothing',
      status: 'no_match',
      notes: ['The workflow has control-flow branches ("deployments") in a shape this importer does not read. Rebuild those branches by hand, and please open an issue with the shape (secrets removed).'],
    })
  }
  const settings = Object.keys(wf.settings)
  if (settings.length > 0) notes.push(`Pipedream workflow settings not carried over: ${settings.join(', ')}. Set the matching Elaichi options (step retry, timeout_seconds, workflow settings) by hand.`)

  if (wf.inactive) notes.push('Inactive in Pipedream.')
  if (wf.unreadFields.length > 0) notes.push(`Top-level fields not read by this importer: ${wf.unreadFields.join(', ')}.`)
  for (const w of opts.manifestWarnings ?? []) notes.push(`Pipedream export warning: ${w}`)

  const count = (all: Step[]): number => all.reduce((n, s) => n + 1 + (Array.isArray(s.branches) ? (s.branches as { steps: Step[] }[]).reduce((m, b) => m + count(b.steps), 0) : 0), 0)
  const summary: Record<Status, number> = { mapped: 0, needs_work: 0, no_match: 0 }
  for (const r of [...stepReports, ...triggerReports]) summary[r.status]++

  if (summary.needs_work + summary.no_match > 0 || ctx.secrets.size > 0) {
    const todo = summary.needs_work + summary.no_match
    steps.unshift({
      key: 'import_review',
      type: 'check',
      name: 'TODO: review this import, then delete this step',
      description: clip(`Imported from Pipedream by pipedream-to-elaichi. ${todo} item${todo === 1 ? ' needs' : 's need'} work (see the migration report). This step fails every run until you delete it.`, 500),
      assert: 'false',
      message: quote(`This workflow was imported from Pipedream and has ${todo} item${todo === 1 ? '' : 's'} to fix. Work through the migration report, reconnect the apps, then delete this step.`),
      severity: 'fail',
    })
  }
  if (count(steps) > 50) notes.push(`This draft has ${count(steps)} steps; Elaichi allows 50. Split it into two workflows (automation.call can join them).`)
  if (ctx.codeSteps > 10) notes.push(`This draft has ${ctx.codeSteps} code steps; Elaichi allows 10. Merge some, or replace them with transform/map_fields steps.`)

  const definition: Definition = { schema_version: 1, triggers, toolboxes: [...ctx.toolboxes], steps }
  const description = clip(
    [`Imported from Pipedream${wf.hashid ? ` (${wf.hashid})` : ''} by pipedream-to-elaichi. Review the TODO steps before you publish.`, wf.description].filter(Boolean).join('\n\n'),
    4000,
  )
  const draft: DraftBody = { name: clip(wf.name, 200), description, definition }
  const report: WorkflowReport = {
    name: wf.name,
    input_file: wf.file,
    output_file: opts.outputFile ?? '',
    ...(wf.hashid ? { pipedream_id: wf.hashid } : {}),
    triggers: triggerReports,
    steps: stepReports,
    reconnect: [...ctx.reconnect].sort(),
    secrets: [...ctx.secrets],
    notes,
    shape_issues: [],
    summary,
  }
  return { draft, report }
}
