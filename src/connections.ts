// Moves Pipedream connected accounts to Elaichi connections, where Pipedream hands over the credentials.
//
// Pipedream side (checked 2026-11-26):
// - GET https://api.pipedream.com/v1/accounts?include_credentials=true lists the accounts the caller can reach
//   (https://pipedream.com/docs/rest-api/api-reference/accounts/list-accounts). Pages: limit (1-100), after = page_info.end_cursor.
// - GET /v1/accounts/{id}?include_credentials=true returns one account with its `credentials` object
//   (https://pipedream.com/docs/rest-api/api-reference/accounts/get-account). OAuth apps expose oauth_access_token,
//   oauth_refresh_token, oauth_client_id and oauth_uid. Key-based apps expose app-specific keys such as api_key.
//   `expires_at` sits on the account, not in `credentials`.
// - Pipedream returns OAuth credentials only for accounts connected with your own OAuth client
//   (https://pipedream.com/docs/connect/api-reference/list-accounts). For key-based apps the docs disagree, so the
//   only test this module trusts is: are credentials present in the answer?
// - Auth: an OAuth client (client credentials, POST /v1/oauth/token, token lasts 1 hour) or a user API key, which
//   needs org_id to name the workspace (https://pipedream.com/docs/rest-api/auth, /docs/rest-api/overview).
//
// Elaichi side: GET /connector/:slug (auth_formats, auth_fields) and POST /connection with
// { connector_slug, name, credentials: { authentication_method, values } }.
//
// Secret rule: credential values live only in memory and in the POST /connection body. Every string this module
// returns for printing or writing goes through a scrubber that blanks any credential value, as a second guard.

import { appOf, TOOL_MAP } from './catalog.ts'
import { request, type ApiOpts, type ApiResponse } from './push.ts'

export interface PdAccount {
  id?: string
  name?: string | null
  app?: { id?: string | null; name?: string; name_slug?: string } | null
  credentials?: Record<string, unknown> | null
  expires_at?: string | null
  authorized_scopes?: string[] | null
  dead?: boolean | null
  healthy?: boolean | null
}

/**
 * importable           — credentials are present and match an Elaichi authentication method.
 * reconnect            — Pipedream returned no credentials (or the account is dead): connect it again in Elaichi.
 * needs_mapping        — credentials are present, but their keys do not match the connector's fields. Add a --map entry.
 * org_oauth_app_needed — an OAuth token: set the same OAuth client as the organization's own OAuth app for that connector first.
 * no_connector         — no Elaichi connector found for the app. Add a --map entry if it has another slug.
 */
export type ConnStatus = 'importable' | 'reconnect' | 'needs_mapping' | 'org_oauth_app_needed' | 'no_connector'
export const CONN_STATUSES: ConnStatus[] = ['importable', 'org_oauth_app_needed', 'needs_mapping', 'no_connector', 'reconnect']

export interface ConnPlanItem {
  pipedream_account_id: string
  pipedream_account_name?: string
  pipedream_app: string
  connector_slug?: string
  status: ConnStatus
  authentication_method?: string
  /** Elaichi field names that --apply sends. Names only, never values. */
  fields?: string[]
  /** Credential key names Pipedream returned. Names only, never values. */
  pipedream_keys?: string[]
  /** The connector's fields per authentication method, for writing a --map entry. */
  elaichi_fields?: Record<string, string[]>
  reasons: string[]
}

export interface ConnPlan {
  schema: 'pipedream-to-elaichi/connections-plan@1'
  generated_at: string
  source: string
  summary: Record<ConnStatus, number>
  accounts: ConnPlanItem[]
}

export interface ConnResult {
  pipedream_account_id: string
  pipedream_app: string
  connector_slug?: string
  ok: boolean
  connection_id?: string
  status?: string
  /** Elaichi's error code: org_oauth_app_required, credential_test_failed, invalid_credentials, … */
  error_code?: string
  /** The field Elaichi named, for invalid_credentials. */
  field?: string
  error?: string
}

/** --map file: Pipedream app slug → Elaichi connector slug, or an object that also names the method and field names. */
export type ConnMap = Record<string, string | { connector?: string; authentication_method?: string; fields?: Record<string, string> }>

interface AuthField {
  name: string
  label?: string
  required?: boolean
  secret?: boolean
}

interface Connector {
  slug: string
  auth_formats: string[]
  auth_fields?: Record<string, AuthField[]>
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** Reads a saved list-accounts answer: one `{ data: [...] }`, an array of such pages, an array of accounts, or `{ data: {...} }`. */
export function accountsFromJson(json: unknown): PdAccount[] {
  const pageData = (p: unknown): PdAccount[] => {
    if (!isRecord(p)) return []
    if (Array.isArray(p.data)) return p.data.filter(isRecord) as PdAccount[]
    if (isRecord(p.data)) return [p.data as PdAccount]
    return []
  }
  if (Array.isArray(json)) return json.some(p => isRecord(p) && 'data' in p) ? json.flatMap(pageData) : (json.filter(isRecord) as PdAccount[])
  if (isRecord(json) && 'data' in json) return pageData(json)
  throw new Error('expected a Pipedream list-accounts answer: { "data": [...] }, an array of those pages, or an array of accounts')
}

/** The account's credentials as strings, or null when Pipedream returned none. */
function credentialsOf(a: PdAccount): Record<string, string> | null {
  if (!isRecord(a.credentials)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(a.credentials)) {
    if (typeof v === 'string' && v !== '') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Every credential value in the accounts, for the scrubber. */
export function secretsOf(accounts: PdAccount[]): string[] {
  const out = new Set<string>()
  for (const a of accounts) {
    if (!isRecord(a.credentials)) continue
    for (const v of Object.values(a.credentials)) if ((typeof v === 'string' || typeof v === 'number') && String(v).length >= 4) out.add(String(v))
  }
  return [...out]
}

/** Returns a function that blanks every secret (and its JSON-escaped form) in a string. */
export function scrubber(secrets: string[]): (s: string) => string {
  const forms = [...new Set(secrets.flatMap(s => [s, JSON.stringify(s).slice(1, -1)]))].sort((a, b) => b.length - a.length)
  return s => {
    let out = s
    for (const f of forms) if (out.includes(f)) out = out.split(f).join('[redacted]')
    return out
  }
}

export function appSlugOf(a: PdAccount): string {
  return a.app?.name_slug || (a.app?.name ? slugify(a.app.name) : '') || 'unknown_app'
}

/** Pipedream app → Elaichi slug pairs this repo already checked in src/catalog.ts (slack_v2 → slack, github → github-mcp). */
const CATALOG_SLUGS = new Map<string, string>()
for (const m of TOOL_MAP) for (const k of m.pipedreamKeys) CATALOG_SLUGS.set(appOf(k), m.slug)

/** Connector slugs to try for a Pipedream app, best first. */
export function candidateSlugs(app: string, map: ConnMap): string[] {
  const o = map[app]
  const forced = typeof o === 'string' ? o : o?.connector
  if (forced) return [forced]
  const base = app.replace(/_(v\d+|bot|oauth|api|app)$/, '')
  return [...new Set([app, app.replace(/_/g, '-'), norm(app), CATALOG_SLUGS.get(app), base, norm(base)].filter((s): s is string => !!s))]
}

function asConnector(json: unknown, slug: string): Connector | null {
  const c = isRecord(json) && isRecord(json.connector) ? json.connector : isRecord(json) && isRecord(json.result) ? json.result : json
  if (!isRecord(c)) return null
  const formats = Array.isArray(c.auth_formats) ? c.auth_formats.filter((f): f is string => typeof f === 'string') : []
  const fields: Record<string, AuthField[]> | undefined = isRecord(c.auth_fields)
    ? Object.fromEntries(Object.entries(c.auth_fields).map(([m, list]) => [m, Array.isArray(list) ? (list.filter(f => isRecord(f) && typeof f.name === 'string') as unknown as AuthField[]) : []]))
    : undefined
  return { slug: typeof c.slug === 'string' ? c.slug : slug, auth_formats: formats, ...(fields ? { auth_fields: fields } : {}) }
}

export class ElaichiError extends Error {}

interface Deps extends ApiOpts {
  sleep?: (ms: number) => Promise<void>
}

/** A request that waits once on 429 (Retry-After, at most 60 s), and stops the run on 401 or 403. */
async function call(method: string, path: string, body: unknown, deps: Deps, fatal = true): Promise<ApiResponse> {
  let r = await request(method, path, body, deps)
  if (r.status === 429) {
    await (deps.sleep ?? (ms => new Promise(res => setTimeout(res, ms))))(Math.min(60, r.retryAfter ?? 5) * 1000)
    r = await request(method, path, body, deps)
  }
  if (fatal && (r.status === 401 || r.status === 403)) throw new ElaichiError(`Elaichi answered ${r.status} ${r.code ?? ''} on ${method} ${path.split('?')[0]}: ${r.message ?? 'check ELAICHI_API_TOKEN'}`.replace(/\s+/g, ' '))
  if (r.networkError !== undefined) throw new ElaichiError(`cannot reach Elaichi: ${r.networkError}`)
  return r
}

async function findConnector(app: string, map: ConnMap, deps: Deps, cache: Map<string, Connector | null>): Promise<Connector | null> {
  if (cache.has(app)) return cache.get(app) ?? null
  let found: Connector | null = null
  for (const slug of candidateSlugs(app, map)) {
    const r = await call('GET', `/connector/${encodeURIComponent(slug)}`, undefined, deps)
    if (r.status === 404) continue
    if (!r.ok) throw new ElaichiError(`Elaichi answered ${r.status} ${r.code ?? ''} on GET /connector/${slug}`.replace(/\s+/g, ' '))
    found = asConnector(r.json, slug)
    if (found) break
  }
  cache.set(app, found)
  return found
}

/** Whether the organization has its own OAuth app for the connector: true, false, or null when the token may not look. */
async function orgOAuthApp(slug: string, deps: Deps, cache: Map<string, { set: boolean | null; clientId?: string }>): Promise<{ set: boolean | null; clientId?: string }> {
  const hit = cache.get(slug)
  if (hit) return hit
  const r = await call('GET', `/connector/${encodeURIComponent(slug)}/oauth-app`, undefined, deps, false)
  let out: { set: boolean | null; clientId?: string }
  if (r.status === 404) out = { set: false }
  else if (!r.ok) out = { set: null }
  else {
    const j = r.json
    const app = isRecord(j) && 'oauth_app' in j ? j.oauth_app : isRecord(j) && 'result' in j ? j.result : j
    const clientId = isRecord(app) && typeof app.client_id === 'string' ? app.client_id : undefined
    out = isRecord(app) ? { set: true, ...(clientId ? { clientId } : {}) } : { set: false }
  }
  cache.set(slug, out)
  return out
}

/** Pipedream credential key → Elaichi oauth2 field. */
const OAUTH_RENAME: Record<string, string> = { oauth_access_token: 'access_token', oauth_refresh_token: 'refresh_token' }
const OAUTH2_DEFAULT_FIELDS = ['access_token', 'refresh_token', 'expires_at', 'scope']

/** Fills a method's fields from the candidate values. Returns the values and any required field left empty. */
function fill(fields: AuthField[], candidates: Record<string, string>, explicit: Record<string, string> | undefined): { values: Record<string, string>; missing: string[] } {
  const byNorm = new Map(Object.entries(candidates).map(([k, v]) => [norm(k), v]))
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const f of fields) {
    const fromKey = explicit && Object.entries(explicit).find(([, to]) => to === f.name)?.[0]
    const v = fromKey !== undefined ? candidates[fromKey] : (candidates[f.name] ?? byNorm.get(norm(f.name)) ?? (f.label ? byNorm.get(norm(f.label)) : undefined))
    if (v !== undefined) values[f.name] = v
    else if (f.required) missing.push(f.name)
  }
  return { values, missing }
}

export interface Classified {
  item: ConnPlanItem
  /** In memory only: what --apply sends. Never written. */
  send?: { connector_slug: string; name?: string; credentials: { authentication_method: string; values: Record<string, string> } }
}

export async function classifyAccount(a: PdAccount, map: ConnMap, deps: Deps, caches: { connectors: Map<string, Connector | null>; oauth: Map<string, { set: boolean | null; clientId?: string }> }): Promise<Classified> {
  const app = appSlugOf(a)
  const item: ConnPlanItem = { pipedream_account_id: a.id ?? '(no id)', ...(a.name ? { pipedream_account_name: a.name } : {}), pipedream_app: app, status: 'reconnect', reasons: [] }
  const creds = credentialsOf(a)
  if (a.dead) {
    item.reasons.push('Pipedream marks this account dead. Connect it again in Elaichi.')
    return { item }
  }
  if (!creds) {
    item.reasons.push('Pipedream returned no credentials. For OAuth apps it only does that for accounts on your own OAuth client. Connect it again in Elaichi.')
    return { item }
  }
  item.pipedream_keys = Object.keys(creds).sort()
  const connector = await findConnector(app, map, deps, caches.connectors)
  if (!connector) {
    item.status = 'no_connector'
    item.reasons.push(`No Elaichi connector found for "${app}" (tried ${candidateSlugs(app, map).join(', ')}). If Elaichi has it under another slug, add it to --map.`)
    return { item }
  }
  item.connector_slug = connector.slug
  if (connector.auth_fields) item.elaichi_fields = Object.fromEntries(Object.entries(connector.auth_fields).map(([m, fs]) => [m, fs.map(f => f.name)]))
  const override = map[app]
  const explicit = typeof override === 'object' ? override.fields : undefined
  const isOAuth = 'oauth_access_token' in creds || 'oauth_refresh_token' in creds

  let method: string | undefined
  let values: Record<string, string> | undefined
  if (isOAuth) {
    if (!connector.auth_formats.includes('oauth2')) {
      item.status = 'needs_mapping'
      item.reasons.push(`Pipedream holds an OAuth token, but Elaichi's ${connector.slug} connector has no oauth2 method (it has: ${connector.auth_formats.join(', ') || 'none'}). Connect it again in Elaichi.`)
      return { item }
    }
    const candidates: Record<string, string> = {}
    // Only fields the connector declares are sent, so oauth_client_id and oauth_uid stay behind.
    for (const [k, v] of Object.entries(creds)) candidates[OAUTH_RENAME[k] ?? k] = v
    if (a.expires_at && !candidates.expires_at) candidates.expires_at = a.expires_at
    if (!candidates.scope && Array.isArray(a.authorized_scopes) && a.authorized_scopes.length > 0) candidates.scope = a.authorized_scopes.join(' ')
    const fields = connector.auth_fields?.oauth2 ?? OAUTH2_DEFAULT_FIELDS.map(name => ({ name, required: name === 'access_token' }))
    const r = fill(fields, candidates, explicit)
    if (r.missing.length > 0) {
      item.status = 'needs_mapping'
      item.authentication_method = 'oauth2'
      item.reasons.push(`Elaichi's oauth2 method needs ${r.missing.join(', ')}, which Pipedream did not return under a matching name. Add "fields" to the --map entry.`)
      return { item }
    }
    method = 'oauth2'
    values = r.values
  } else {
    const wanted = typeof override === 'object' ? override.authentication_method : undefined
    const methods = (wanted ? [wanted] : connector.auth_formats).filter(m => m !== 'oauth2')
    for (const m of methods) {
      const fields = connector.auth_fields?.[m]
      if (!fields || fields.length === 0) continue
      const r = fill(fields, creds, explicit)
      if (r.missing.length === 0 && Object.keys(r.values).length > 0) {
        method = m
        values = r.values
        break
      }
    }
    if (!method || !values) {
      item.status = 'needs_mapping'
      item.reasons.push(
        connector.auth_fields
          ? `Pipedream's keys (${item.pipedream_keys.join(', ')}) do not fill any of the ${connector.slug} connector's methods. Add a --map entry with "authentication_method" and "fields".`
          : `Elaichi did not list the ${connector.slug} connector's fields (auth_fields). Add a --map entry with "authentication_method" and "fields".`,
      )
      return { item }
    }
  }
  item.authentication_method = method
  item.fields = Object.keys(values).sort()
  const send = { connector_slug: connector.slug, ...(a.name ? { name: a.name } : {}), credentials: { authentication_method: method, values } }

  if (method === 'oauth2') {
    const own = await orgOAuthApp(connector.slug, deps, caches.oauth)
    const pdClient = creds.oauth_client_id
    if (own.set === false) {
      item.status = 'org_oauth_app_needed'
      item.reasons.push(`The token was issued by your own OAuth client in Pipedream. In Elaichi, set that same client as the organization's own OAuth app for ${connector.slug} (Connectors → ${connector.slug} → OAuth app), then run this again.`)
      return { item, send }
    }
    if (own.set && own.clientId && pdClient && own.clientId !== pdClient) {
      item.status = 'org_oauth_app_needed'
      item.reasons.push(`The organization's OAuth app for ${connector.slug} is a different client from the one that issued this token. Set the same client in Elaichi, or connect the account again.`)
      return { item, send }
    }
    if (own.set === null) item.reasons.push(`Could not check the organization's OAuth app for ${connector.slug} (needs the connector:manage permission). --apply will say if it is missing.`)
  }
  if (a.healthy === false) item.reasons.push('Pipedream marks this account unhealthy. Elaichi tests the credentials and may refuse them.')
  item.status = 'importable'
  return { item, send }
}

export async function planConnections(accounts: PdAccount[], map: ConnMap, deps: Deps, source: string): Promise<{ plan: ConnPlan; classified: Classified[] }> {
  const caches = { connectors: new Map<string, Connector | null>(), oauth: new Map<string, { set: boolean | null; clientId?: string }>() }
  const classified: Classified[] = []
  for (const a of accounts) classified.push(await classifyAccount(a, map, deps, caches))
  const summary = Object.fromEntries(CONN_STATUSES.map(s => [s, 0])) as Record<ConnStatus, number>
  for (const c of classified) summary[c.item.status]++
  return { plan: { schema: 'pipedream-to-elaichi/connections-plan@1', generated_at: new Date().toISOString(), source, summary, accounts: classified.map(c => c.item) }, classified }
}

/** Creates each importable connection with POST /connection, one at a time. Stops at a 401 or 403. */
export async function applyConnections(classified: Classified[], deps: Deps): Promise<ConnResult[]> {
  const results: ConnResult[] = []
  let stopped: string | undefined
  for (const c of classified) {
    if (c.item.status !== 'importable' || !c.send) continue
    const base = { pipedream_account_id: c.item.pipedream_account_id, pipedream_app: c.item.pipedream_app, connector_slug: c.send.connector_slug }
    if (stopped) {
      results.push({ ...base, ok: false, error_code: 'skipped', error: `Not sent: ${stopped}` })
      continue
    }
    let r: ApiResponse
    try {
      r = await call('POST', '/connection', c.send, deps, false)
    } catch (e) {
      results.push({ ...base, ok: false, error: (e as Error).message })
      continue
    }
    if (r.ok) {
      const j = r.json
      const conn = isRecord(j) && isRecord(j.connection) ? j.connection : isRecord(j) && isRecord(j.result) ? j.result : j
      results.push({ ...base, ok: true, ...(isRecord(conn) && typeof conn.id === 'string' ? { connection_id: conn.id } : {}), ...(isRecord(conn) && typeof conn.status === 'string' ? { status: conn.status } : {}) })
      continue
    }
    const d = isRecord(r.details) ? r.details : {}
    const field = typeof d.field === 'string' ? d.field : isRecord(r.json) && typeof r.json.field === 'string' ? r.json.field : undefined
    // Only the status, code and Elaichi's own message: never the raw body, which could echo what was sent.
    results.push({ ...base, ok: false, error_code: r.code ?? `http_${r.status}`, ...(field ? { field } : {}), error: `${r.status} ${r.message ?? ''}`.trim() })
    if (r.status === 401 || r.status === 403) stopped = `Elaichi answered ${r.status} ${r.code ?? ''} on an earlier account.`.replace(/\s+/g, ' ')
  }
  return results
}

/** What to do next for an apply error code. */
export function errorHelp(code: string | undefined): string {
  switch (code) {
    case 'org_oauth_app_required':
      return 'Set the same OAuth client as the organization\'s own OAuth app for this connector in Elaichi, then run --apply again for the rest.'
    case 'credential_test_failed':
      return 'Elaichi tested the credentials and the app refused them. Connect the account again in Elaichi.'
    case 'invalid_credentials':
      return 'A field is wrong or missing. Fix the --map entry for this app.'
    case 'rate_limited':
    case 'http_429':
      return 'Rate limited. Wait, then run --apply again.'
    default:
      return ''
  }
}

// ---------- Pipedream live fetch ----------

export interface PdEnv {
  PIPEDREAM_CLIENT_ID?: string
  PIPEDREAM_CLIENT_SECRET?: string
  PIPEDREAM_API_KEY?: string
  PIPEDREAM_ORG_ID?: string
  PIPEDREAM_API_URL?: string
}

export const PIPEDREAM_ENV_HELP =
  'Set PIPEDREAM_CLIENT_ID and PIPEDREAM_CLIENT_SECRET (an OAuth client from your workspace\'s API settings, https://pipedream.com/settings/api), or PIPEDREAM_API_KEY with PIPEDREAM_ORG_ID (your workspace id, o_…). Or pass --accounts-file.'

/**
 * Fetches the workspace's connected accounts with credentials: GET /v1/accounts?include_credentials=true, every page,
 * then GET /v1/accounts/{id}?include_credentials=true for any account that came back without credentials.
 * Error messages carry the status and path only, never a body.
 */
export async function fetchPipedreamAccounts(env: PdEnv, fetchFn: typeof fetch = fetch): Promise<PdAccount[]> {
  const base = (env.PIPEDREAM_API_URL ?? 'https://api.pipedream.com/v1').replace(/\/+$/, '')
  let token: string
  const orgId = env.PIPEDREAM_ORG_ID
  if (env.PIPEDREAM_CLIENT_ID && env.PIPEDREAM_CLIENT_SECRET) {
    const res = await fetchFn(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.PIPEDREAM_CLIENT_ID, client_secret: env.PIPEDREAM_CLIENT_SECRET }),
    })
    const j = (await res.json().catch(() => undefined)) as { access_token?: string } | undefined
    if (!res.ok || !j?.access_token) throw new Error(`Pipedream answered ${res.status} on POST /oauth/token. Check PIPEDREAM_CLIENT_ID and PIPEDREAM_CLIENT_SECRET.`)
    token = j.access_token
  } else if (env.PIPEDREAM_API_KEY) {
    if (!orgId) throw new Error('PIPEDREAM_API_KEY needs PIPEDREAM_ORG_ID (your workspace id, o_…) to name the workspace.')
    token = env.PIPEDREAM_API_KEY
  } else throw new Error(PIPEDREAM_ENV_HELP)

  const get = async (path: string, params: Record<string, string>) => {
    const q = new URLSearchParams({ ...params, include_credentials: 'true', ...(orgId ? { org_id: orgId } : {}) })
    const res = await fetchFn(`${base}${path}?${q}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Pipedream answered ${res.status} on GET ${path}.`)
    return (await res.json()) as { data?: unknown; page_info?: { end_cursor?: string | null } }
  }

  const accounts: PdAccount[] = []
  const seen = new Set<string>()
  let after: string | undefined
  for (let page = 0; page < 200; page++) {
    const j = await get('/accounts', { limit: '100', ...(after ? { after } : {}) })
    const data = Array.isArray(j.data) ? (j.data.filter(isRecord) as PdAccount[]) : []
    accounts.push(...data)
    const next = j.page_info?.end_cursor ?? undefined
    if (data.length === 0 || !next || seen.has(next)) break
    seen.add(next)
    after = next
  }
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i] as PdAccount
    if (a.id && !credentialsOf(a) && !a.dead) {
      const j = await get(`/accounts/${encodeURIComponent(a.id)}`, {})
      if (isRecord(j.data)) accounts[i] = { ...a, ...(j.data as PdAccount) }
    }
  }
  return accounts
}
