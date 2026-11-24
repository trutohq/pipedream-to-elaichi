import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readZip } from './zip.ts'

// Pipedream's docs confirm the archive layout, manifest.json and a workflow file's top-level
// fields (name, description, inactive, settings, triggers, steps, deployments). They do NOT
// publish the field names inside a step or trigger, so this parser accepts every spelling seen
// in Pipedream-written GitHub Sync files and in other converters. See FORMAT.md.

export type Obj = Record<string, unknown>

export interface PdStep {
  namespace: string
  /** `nodejs20.x`, `python3.12`, `go1.21`, `bash`, … */
  runtime?: string
  /** Inline code (code steps). */
  code?: string
  /** Code that lived in a separate file (GitHub Sync `uses: ./x/entry.js`); its text is not in this file. */
  codePath?: string
  /** Registry or private component key, without `@version`. */
  componentKey?: string
  componentVersion?: string
  props: Obj
  disabled: boolean
  /** Every field the step had, for a clear TODO when the shape is not recognized. */
  rawKeys: string[]
}

export interface PdTrigger {
  type: string
  props: Obj
  disabled: boolean
  cron?: string
  intervalSeconds?: number
  timezone?: string
  sourceKey?: string
  rawKeys: string[]
}

export interface PdBranch {
  id: string
  steps: PdStep[]
}

export interface PdWorkflow {
  file: string
  name: string
  description: string
  inactive: boolean
  hashid?: string
  triggers: PdTrigger[]
  steps: PdStep[]
  branches: PdBranch[]
  /** `deployments` has content, but no branch steps could be read from it. */
  deploymentsUnread: boolean
  /** Workflow-level settings (retries, concurrency, and so on); not converted. */
  settings: Obj
  /** Top-level fields this importer does not read. */
  unreadFields: string[]
}

export interface ManifestEntry {
  hashid?: string
  name?: string
  path?: string
  status?: string
  warnings: string[]
}

export interface Manifest {
  truncated: boolean
  truncatedReason?: string
  workflows: ManifestEntry[]
}

export interface LoadedInput {
  manifest?: Manifest
  files: { file: string; raw: unknown }[]
  /** Files that were not JSON, or JSON that could not be read. */
  unreadable: { file: string; reason: string }[]
}

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined)
const obj = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined)

/** `slack_v2-send-message@0.3.2` → key and version. A scoped private key `@ws/x@1.0.0` keeps its leading `@`. */
export function splitKey(uses: string): { key: string; version?: string } {
  const at = uses.lastIndexOf('@')
  if (at > 0) return { key: uses.slice(0, at), version: uses.slice(at + 1) }
  return { key: uses }
}

export function parseStep(raw: unknown, index: number): PdStep {
  const s = obj(raw) ?? {}
  const namespace = str(s.namespace) ?? str(s.name) ?? str(s.id) ?? `step_${index + 1}`
  const runtime = str(s.lang) ?? str(s.runtime) ?? str(s.language)
  let code: string | undefined
  let codePath: string | undefined
  let componentKey: string | undefined
  let componentVersion: string | undefined

  const uses = s.uses
  if (typeof uses === 'string') {
    if (uses.startsWith('./') || uses.startsWith('/')) codePath = uses
    else ({ key: componentKey, version: componentVersion } = splitKey(uses))
  } else if (isObj(uses)) {
    code = str(uses.code)
    if (str(uses.key)) ({ key: componentKey, version: componentVersion } = splitKey(String(uses.key)))
    componentVersion = str(uses.version) ?? componentVersion
  }
  code ??= str(s.code) ?? (isObj(s.source) ? str(s.source.code) : str(s.source))
  if (!componentKey) {
    const k = str(s.component_key) ?? str(s.componentKey) ?? str(s.component) ?? str(s.key_version)
    if (k) ({ key: componentKey, version: componentVersion } = splitKey(k))
  }
  // A step with code is a code step even if it also names a component.
  if (code) componentKey = componentKey && isObj(uses) && uses.registry === true ? componentKey : undefined

  const props = obj(s.props) ?? obj(s.configured_props) ?? obj(s.configuredProps) ?? {}
  return {
    namespace,
    runtime,
    code,
    codePath,
    componentKey,
    componentVersion,
    props,
    disabled: s.disabled === true,
    rawKeys: Object.keys(s),
  }
}

const TRIGGER_ID_PREFIX: Record<string, string> = { ti_: 'timer', hi_: 'http', dc_: 'source', ei_: 'email' }

export function parseTrigger(raw: unknown): PdTrigger {
  const t = obj(raw) ?? {}
  const props = obj(t.props) ?? obj(t.configured_props) ?? obj(t.configuredProps) ?? {}
  const timer = obj(props.timer) ?? obj(t.timer) ?? {}
  const id = str(t.id) ?? ''
  const prefixType = Object.entries(TRIGGER_ID_PREFIX).find(([p]) => id.startsWith(p))?.[1]
  const type = (str(t.type) ?? prefixType ?? 'unknown').toLowerCase()
  let sourceKey = str(t.key) ?? str(t.component_key) ?? str(t.componentKey)
  if (!sourceKey && typeof t.uses === 'string') sourceKey = t.uses
  if (!sourceKey && isObj(t.uses)) sourceKey = str(t.uses.key)
  return {
    type,
    props,
    disabled: t.disabled === true,
    cron: str(props.cron) ?? str(timer.cron) ?? str(t.cron),
    intervalSeconds:
      num(props.interval_seconds) ?? num(props.intervalSeconds) ?? num(timer.intervalSeconds) ?? num(timer.interval_seconds) ?? num(t.interval_seconds) ?? num(t.intervalSeconds),
    timezone: str(props.timezone) ?? str(timer.timezone) ?? str(t.timezone),
    sourceKey: sourceKey ? splitKey(sourceKey).key : undefined,
    rawKeys: Object.keys(t),
  }
}

/** `deployments` holds the steps inside control-flow branches. Its inner shape is not documented: accept an object of `{ steps }` or an array of `{ id, steps }`. */
function parseBranches(raw: unknown): PdBranch[] {
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((d, i) => [str(obj(d)?.id) ?? `branch_${i + 1}`, d])
    : isObj(raw)
      ? Object.entries(raw)
      : []
  const out: PdBranch[] = []
  for (const [id, d] of entries) {
    const steps = Array.isArray(d) ? d : Array.isArray(obj(d)?.steps) ? (obj(d)?.steps as unknown[]) : []
    if (steps.length > 0) out.push({ id, steps: steps.map(parseStep) })
  }
  return out
}

const hasContent = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : false)

const KNOWN_TOP = new Set(['schema', 'name', 'description', 'inactive', 'settings', 'triggers', 'steps', 'deployments', 'hashid', 'id'])

export function looksLikeWorkflow(raw: unknown): raw is Obj {
  return isObj(raw) && Array.isArray(raw.steps) && (Array.isArray(raw.triggers) || 'name' in raw)
}

export function parseWorkflow(raw: unknown, file: string): PdWorkflow {
  if (!looksLikeWorkflow(raw)) throw new Error(`${file} is not a Pipedream workflow file (no steps array)`)
  const branches = parseBranches(raw.deployments)
  return {
    file,
    name: str(raw.name) ?? file.replace(/\.json$/i, ''),
    description: str(raw.description) ?? '',
    inactive: raw.inactive === true,
    hashid: str(raw.hashid) ?? str(raw.id),
    triggers: (Array.isArray(raw.triggers) ? raw.triggers : []).map(parseTrigger),
    steps: (raw.steps as unknown[]).map(parseStep),
    branches,
    deploymentsUnread: branches.length === 0 && hasContent(raw.deployments),
    settings: obj(raw.settings) ?? {},
    unreadFields: Object.keys(raw).filter(k => !KNOWN_TOP.has(k)),
  }
}

export function parseManifest(raw: unknown): Manifest {
  const m = obj(raw) ?? {}
  return {
    truncated: m.truncated === true,
    truncatedReason: str(m.truncated_reason),
    workflows: (Array.isArray(m.workflows) ? m.workflows : []).map(w => {
      const e = obj(w) ?? {}
      return {
        hashid: str(e.hashid),
        name: str(e.name),
        path: str(e.path),
        status: str(e.status),
        warnings: Array.isArray(e.warnings) ? e.warnings.filter((x): x is string => typeof x === 'string') : [],
      }
    }),
  }
}

function collect(entries: Iterable<[string, Uint8Array | (() => Uint8Array)]>): LoadedInput {
  const out: LoadedInput = { files: [], unreadable: [] }
  const decoder = new TextDecoder()
  for (const [name, data] of entries) {
    const base = name.split('/').pop() ?? name
    if (!base.toLowerCase().endsWith('.json') || base.startsWith('._')) continue
    let raw: unknown
    try {
      raw = JSON.parse(decoder.decode(typeof data === 'function' ? data() : data))
    } catch (e) {
      out.unreadable.push({ file: name, reason: `not valid JSON: ${(e as Error).message}` })
      continue
    }
    if (base === 'manifest.json') out.manifest = parseManifest(raw)
    else out.files.push({ file: name, raw })
  }
  out.files.sort((a, b) => a.file.localeCompare(b.file))
  return out
}

function walk(dir: string, root: string, acc: [string, () => Uint8Array][]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, root, acc)
    else acc.push([relative(root, p).split('\\').join('/'), () => readFileSync(p)])
  }
}

/** A project export `.zip`, an unzipped export folder, or one workflow `.json`. */
export function loadInput(path: string): LoadedInput {
  const st = statSync(path)
  if (st.isDirectory()) {
    const acc: [string, () => Uint8Array][] = []
    walk(path, path, acc)
    return collect(acc)
  }
  if (path.toLowerCase().endsWith('.zip')) return collect(readZip(readFileSync(path)))
  const name = path.split(/[\\/]/).pop() ?? path
  return collect([[name, () => readFileSync(path)]])
}
