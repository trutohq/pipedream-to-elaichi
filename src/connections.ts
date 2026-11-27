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
// Elaichi side: GET /connector/:slug (auth_formats, auth_fields per method), GET /connector/:slug/oauth-app
// ({ oauth_app_mode: "platform_default" | "byoa", client_id, … }; needs connector:manage) and POST /connection with
// { connector_slug, name, credentials: { authentication_method, values } } → 201 { connection: { id, status } }.
// Errors carry a `code`; a field problem names it in details.field (credentials.values.<field>).
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
  /** Set by fetchPipedreamAccounts when the per-account GET failed (status and path only). */
  fetch_error?: string
}

/**
 * importable           — credentials are present and match an Elaichi authentication method.
 * reconnect            — Pipedream returned no credentials (or the account is dead): connect it again in Elaichi.
 * needs_mapping        — credentials are present, but their keys do not match the connector's fields. Add a --map entry.
 * org_oauth_app_needed — an OAuth token: set the same OAuth client as the organization's own OAuth app for that connector first.
 * org_oauth_app_unknown — an OAuth token, but the token may not read the organization's OAuth app (needs connector:manage).
 *                         --apply still sends it; Elaichi answers org_oauth_app_required if the app is missing.
 * no_connector         — no Elaichi connector found for the app. Add a --map entry if it has another slug.
 * restricted           — the organization's rules block this connector (GET /connector/:slug says `restricted: true`). Not sent.
 */
export type ConnStatus = 'importable' | 'reconnect' | 'needs_mapping' | 'org_oauth_app_needed' | 'org_oauth_app_unknown' | 'no_connector' | 'restricted'
export const CONN_STATUSES: ConnStatus[] = ['importable', 'org_oauth_app_unknown', 'org_oauth_app_needed', 'needs_mapping', 'no_connector', 'restricted', 'reconnect']
/** Statuses --apply sends. */
export const SENDABLE: ConnStatus[] = ['importable', 'org_oauth_app_unknown']

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
  /** The connection name sent to Elaichi (the Pipedream account name), to find it in Elaichi. */
  connection_name?: string
  ok: boolean
  connection_id?: string
  status?: string
  /** From the 201 connection: whether Elaichi tested the credentials against the app. */
  credential_tested?: boolean
  /**
   * Elaichi's error code: org_oauth_app_required, credential_test_failed, invalid_credentials, …
   * Or this tool's own: `skipped` (not sent), `pending` (sent, no answer recorded yet) and `unknown_outcome`
   * (no answer, or a 5xx: the connection may exist). A re-run does not send `pending` or `unknown_outcome`
   * again without --retry-unknown. `post_install_error` goes with `ok: true`: the connection exists but needs repair.
   */
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
  restricted?: boolean
  auth_formats: string[]
  auth_fields?: Record<string, AuthField[]>
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const brief = (r: ApiResponse) => `${r.status} ${r.code ?? ''} ${r.message ?? ''}`.replace(/\s+/g, ' ').trim()
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** Drops a repeated pipedream_account_id, so one account is never sent twice in a run. Accounts without an id stay. */
export function dedupeAccounts(accounts: PdAccount[]): PdAccount[] {
  const seen = new Set<string>()
  return accounts.filter(a => !a.id || (!seen.has(a.id) && !!seen.add(a.id)))
}

/** Reads a saved list-accounts answer: one `{ data: [...] }`, an array of such pages, an array of accounts, or `{ data: {...} }`. */
export function accountsFromJson(json: unknown): PdAccount[] {
  return dedupeAccounts(readAccounts(json))
}

function readAccounts(json: unknown): PdAccount[] {
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
    // ponytail: a value under 4 characters is not scrubbed (it would blank ordinary words); a real secret is longer.
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

/** Scrubs every string value (and key) inside an object, so JSON.stringify of the result is valid and no `"ok": false` or id is damaged. */
export function scrubDeep(scrub: (s: string) => string): (v: unknown) => unknown {
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(walk) : isRecord(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)])) : v
  return walk
}

export function appSlugOf(a: PdAccount): string {
  return a.app?.name_slug || (a.app?.name ? slugify(a.app.name) : '') || 'unknown_app'
}

/** Pipedream app → Elaichi slug pairs this repo already checked in src/catalog.ts (slack_v2 → slack, github → github-mcp). */
const CATALOG_SLUGS = new Map<string, string>()
for (const m of TOOL_MAP) for (const k of m.pipedreamKeys) CATALOG_SLUGS.set(appOf(k), m.slug)

/** Connector slugs to try for a Pipedream app, best first. ponytail: a name-guessing heuristic, not a lookup; --map is the fix for a miss. */
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
  return { slug: typeof c.slug === 'string' ? c.slug : slug, ...(c.restricted === true ? { restricted: true } : {}), auth_formats: formats, ...(fields ? { auth_fields: fields } : {}) }
}

export class ElaichiError extends Error {}

interface Deps extends ApiOpts {
  sleep?: (ms: number) => Promise<void>
}

const sleepMs = (ms: number) => new Promise<void>(res => setTimeout(res, ms))
/** ponytail: one retry on 429, waiting Retry-After capped at 60 s (5 s when absent). A second 429 is an ordinary failure; add backoff if that bites. */
const retryWaitMs = (retryAfter?: number) => Math.min(60, retryAfter ?? 5) * 1000

/** A request that waits once on 429, and stops the run on 401 or 403. */
async function call(method: string, path: string, body: unknown, deps: Deps, fatal = true): Promise<ApiResponse> {
  let r = await request(method, path, body, deps)
  if (r.status === 429) {
    await (deps.sleep ?? sleepMs)(retryWaitMs(r.retryAfter))
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
    if (!r.ok) throw new ElaichiError(`Elaichi answered ${brief({ ...r, message: undefined })} on GET /connector/${slug}`)
    found = asConnector(r.json, slug)
    if (found) break
  }
  cache.set(app, found)
  return found
}

/**
 * The organization's OAuth app for a connector: GET /connector/:slug/oauth-app, which answers
 * { oauth_app_mode: "platform_default" | "byoa", client_id, … }. `set` is null when the token may not look
 * (403: needs connector:manage) or the answer is unexpected: then nothing is guessed.
 */
type OAuthApp = { set: boolean | null; clientId?: string; notFound?: boolean }

async function orgOAuthApp(slug: string, deps: Deps, cache: Map<string, OAuthApp>): Promise<OAuthApp> {
  const hit = cache.get(slug)
  if (hit) return hit
  const r = await call('GET', `/connector/${encodeURIComponent(slug)}/oauth-app`, undefined, deps, false)
  const j = isRecord(r.json) ? r.json : {}
  const out: OAuthApp =
    r.ok && j.oauth_app_mode === 'byoa' ? { set: true, ...(typeof j.client_id === 'string' ? { clientId: j.client_id } : {}) } : r.ok && j.oauth_app_mode === 'platform_default' ? { set: false } : r.status === 404 ? { set: null, notFound: true } : { set: null }
  cache.set(slug, out)
  return out
}

/** Pipedream credential key → Elaichi oauth2 field. */
// token_type and id_token are sent only when the connector's oauth2 auth_fields list them (fill reads the connector's list).
const OAUTH_RENAME: Record<string, string> = { oauth_access_token: 'access_token', oauth_refresh_token: 'refresh_token', oauth_token_type: 'token_type', oauth_id_token: 'id_token' }

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

export async function classifyAccount(a: PdAccount, map: ConnMap, deps: Deps, caches: { connectors: Map<string, Connector | null>; oauth: Map<string, OAuthApp> }): Promise<Classified> {
  const app = appSlugOf(a)
  const item: ConnPlanItem = { pipedream_account_id: a.id ?? '(no id)', ...(a.name ? { pipedream_account_name: a.name } : {}), pipedream_app: app, status: 'reconnect', reasons: [] }
  const creds = credentialsOf(a)
  if (!a.id) {
    // The account id is the resume key for --apply: without one, a re-run could not tell this account from another.
    item.reasons.push('Pipedream gave this account no id, so it cannot be imported safely. Connect it again in Elaichi.')
    return { item }
  }
  if (a.dead) {
    item.reasons.push('Pipedream marks this account dead. Connect it again in Elaichi.')
    return { item }
  }
  if (a.fetch_error) {
    item.reasons.push(`Fetching this account from Pipedream failed (${a.fetch_error}). Run again, or connect it again in Elaichi.`)
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
  if (connector.restricted) {
    item.status = 'restricted'
    item.reasons.push(`Your organization's rules block the ${connector.slug} connector. Ask an admin for access, then run this again. Other accounts are not affected.`)
    return { item }
  }
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
    // Both spellings are candidates, so a --map "fields" entry can use Pipedream's own key name (oauth_access_token) or the renamed one.
    for (const [k, v] of Object.entries(creds)) {
      candidates[k] = v
      if (OAUTH_RENAME[k]) candidates[OAUTH_RENAME[k]] = v
    }
    if (a.expires_at && !candidates.expires_at) candidates.expires_at = a.expires_at
    if (!candidates.scope && Array.isArray(a.authorized_scopes) && a.authorized_scopes.length > 0) candidates.scope = a.authorized_scopes.join(' ')
    const fields = connector.auth_fields?.oauth2
    if (!fields || fields.length === 0) {
      // Elaichi refuses values it does not list, so nothing is sent without the connector's own field list.
      item.status = 'needs_mapping'
      item.reasons.push(`Elaichi did not list the ${connector.slug} connector's oauth2 fields (auth_fields.oauth2), so the tool cannot tell what to send. Connect it again in Elaichi.`)
      return { item }
    }
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
    // A --map entry may name oauth2 for a key-based account whose fields map to access_token / refresh_token.
    const methods = wanted ? [wanted] : connector.auth_formats.filter(m => m !== 'oauth2')
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
      item.reasons.push(`The token was issued by your own OAuth client in Pipedream, and Elaichi uses its own client for ${connector.slug}. In Elaichi, set that same client as the organization's own OAuth app for ${connector.slug} (Connectors → ${connector.slug} → OAuth app), then run this again.`)
      return { item, send }
    }
    if (own.set && own.clientId && pdClient && own.clientId !== pdClient) {
      item.status = 'org_oauth_app_needed'
      item.reasons.push(`The organization's OAuth app for ${connector.slug} is a different client from the one that issued this token. Set the same client in Elaichi, or connect the account again.`)
      return { item, send }
    }
    if (own.set === null) {
      item.status = 'org_oauth_app_unknown'
      item.reasons.push(
        own.notFound
          ? `Elaichi has no organization OAuth app to read for ${connector.slug} (the connector may be custom or take no own OAuth app). --apply sends it; Elaichi answers org_oauth_app_required if one is needed.`
          : `Could not read the organization's OAuth app for ${connector.slug} (needs the connector:manage permission). --apply sends it; Elaichi answers org_oauth_app_required if the app is missing or a different client.`,
      )
      return { item, send }
    }
  }
  if (a.healthy === false) item.reasons.push('Pipedream marks this account unhealthy. Elaichi tests the credentials and may refuse them.')
  item.status = 'importable'
  return { item, send }
}

export async function planConnections(accounts: PdAccount[], map: ConnMap, deps: Deps, source: string): Promise<{ plan: ConnPlan; classified: Classified[] }> {
  const caches = { connectors: new Map<string, Connector | null>(), oauth: new Map<string, OAuthApp>() }
  const classified: Classified[] = []
  for (const a of accounts) classified.push(await classifyAccount(a, map, deps, caches))
  const summary = Object.fromEntries(CONN_STATUSES.map(s => [s, 0])) as Record<ConnStatus, number>
  for (const c of classified) summary[c.item.status]++
  return { plan: { schema: 'pipedream-to-elaichi/connections-plan@1', generated_at: new Date().toISOString(), source, summary, accounts: classified.map(c => c.item) }, classified }
}

/** Error codes that leave it unknown whether Elaichi created the connection. */
export const UNKNOWN_OUTCOME = ['pending', 'unknown_outcome']

/**
 * Creates each importable connection with POST /connection, one at a time. Stops at 401, 428, 503, or a 403 that
 * applies to the whole token (see stopsRun). A per-connector 403 `forbidden` fails only that account.
 * `skip` holds Pipedream account ids not to send (created, or unknown outcome). `onPending` runs just before each
 * POST and `onResult` just after, so a result file always shows an account in flight as `pending`.
 */
export async function applyConnections(
  classified: Classified[],
  deps: Deps,
  opts: { skip?: Set<string>; onPending?: (r: ConnResult) => void; onResult?: (r: ConnResult) => void } = {},
): Promise<ConnResult[]> {
  const results: ConnResult[] = []
  const push = (r: ConnResult) => {
    results.push(r)
    opts.onResult?.(r)
  }
  let stopped: string | undefined
  const sent = new Set<string>()
  for (const c of classified) {
    if (!SENDABLE.includes(c.item.status) || !c.send || opts.skip?.has(c.item.pipedream_account_id) || sent.has(c.item.pipedream_account_id)) continue
    sent.add(c.item.pipedream_account_id)
    const base = { pipedream_account_id: c.item.pipedream_account_id, pipedream_app: c.item.pipedream_app, connector_slug: c.send.connector_slug, ...(c.send.name ? { connection_name: c.send.name } : {}) }
    if (stopped) {
      push({ ...base, ok: false, error_code: 'skipped', error: `Not sent: ${stopped}` })
      continue
    }
    opts.onPending?.({ ...base, ok: false, error_code: 'pending', error: 'Sent to Elaichi; no answer recorded. The connection may exist.' })
    let r: ApiResponse
    try {
      r = await call('POST', '/connection', c.send, deps, false)
    } catch (e) {
      push({ ...base, ok: false, error_code: 'unknown_outcome', error: (e as Error).message })
      continue
    }
    if (r.ok) {
      const j = r.json
      const conn = isRecord(j) && isRecord(j.connection) ? j.connection : j
      const repair = isRecord(conn) && conn.status === 'post_install_error'
      push({
        ...base,
        ok: true,
        // Created, but its post-install step failed: it needs POST /connection/:id/run-post-install.
        ...(repair ? { error_code: 'post_install_error', error: 'Created, but its post-install step failed.' } : {}),
        ...(isRecord(conn) && typeof conn.id === 'string' ? { connection_id: conn.id } : {}),
        ...(isRecord(conn) && typeof conn.status === 'string' ? { status: conn.status } : {}),
        ...(isRecord(conn) && typeof conn.credential_tested === 'boolean' ? { credential_tested: conn.credential_tested } : {}),
      })
      continue
    }
    // A coded 500 internal_error is Elaichi's own answer: it has already cleaned up, so it is a plain failure.
    // provider_unavailable (502/503): the app did not answer, Elaichi cleaned up first. A plain failure a re-run may resend.
    if (r.status >= 500 && r.status !== 503 && r.code !== 'provider_unavailable' && !(r.status === 500 && r.code === 'internal_error')) {
      push({ ...base, ok: false, error_code: 'unknown_outcome', error: brief(r) })
      continue
    }
    const d = isRecord(r.details) ? r.details : {}
    const field = typeof d.field === 'string' ? d.field : isRecord(r.json) && typeof r.json.field === 'string' ? r.json.field : undefined
    // Only the status, code and Elaichi's own message: never the raw body, which could echo what was sent.
    push({ ...base, ok: false, error_code: r.code ?? `http_${r.status}`, ...(field ? { field } : {}), error: `${r.status} ${r.message ?? ''}`.trim() })
    if (stopsRun(r)) stopped = `Elaichi answered ${r.status} ${r.code ?? ''} on an earlier account. ${errorHelp(r.code ?? `http_${r.status}`)}`.replace(/\s+/g, ' ').trim()
  }
  return results
}

/**
 * Answers that make every later account fail the same way, so the run stops: 401 (token), 428 (step-up, which an
 * API token should never get), 503 (connection_import_unavailable, platform_connections_stopped, …) and a 403 that
 * is about the whole token: `permission_required`, or `staff_import_refused`.
 * A 403 `forbidden` about one connector ("restricted for your account") is that account's failure only.
 */
const STOP_STATUSES = [401, 428, 503]
const stopsRun = (r: ApiResponse) => (STOP_STATUSES.includes(r.status) && r.code !== 'provider_unavailable') || (r.status === 403 && (r.code === 'permission_required' || r.code === 'staff_import_refused'))

/** What to do next for an apply error code. */
export function errorHelp(code: string | undefined): string {
  switch (code) {
    case 'org_oauth_app_required':
      return 'Set the same OAuth client as the organization\'s own OAuth app for this connector in Elaichi, then run --apply again: it skips the accounts already created.'
    case 'credential_test_failed':
      return 'Elaichi tested the credentials and the app refused them. Connect the account again in Elaichi.'
    case 'credential_test_timeout':
      return 'The app took too long to answer Elaichi\'s credential check. Run --apply again later, or connect the account again.'
    case 'unknown_outcome':
    case 'pending':
      return 'No clear answer: the connection may exist. Check Elaichi for a connection with this name before you send it again with --retry-unknown.'
    case 'validation_error':
    case 'invalid_credentials':
    case 'missing_required_field':
    case 'invalid_field':
    case 'transform_failed':
      return 'A field is wrong or missing. Fix the --map entry for this app.'
    case 'unsupported_authentication_method':
      return 'The connector does not take this method. Pick another "authentication_method" in --map, or connect the account again.'
    case 'integration_not_installed':
      return 'This connector is not set up in your Elaichi organization. Add it in Elaichi, or connect the account again.'
    case 'connection_import_unavailable':
      return 'Elaichi cannot import connections yet. Nothing more was sent. Run --apply again later.'
    case 'platform_connections_stopped':
      return 'Elaichi has paused connection changes for the whole platform. Nothing more was sent. Run --apply again later.'
    case 'http_503':
      return 'Elaichi is unavailable. Nothing more was sent. Run --apply again later.'
    case 'provider_unavailable':
      return 'The app\'s server did not answer, and nothing was kept. Run --apply again later.'
    case 'internal_error':
      return 'Elaichi had an error and cleaned up, so no connection was kept. Run --apply again.'
    case 'post_install_error':
      return 'The connection exists but its post-install step failed. Repair it: POST /connection/<id>/run-post-install (or repair it in Elaichi), then check its status.'
    case 'step_up_required':
      return 'Elaichi asked to re-verify, which should not happen with an API token. Please report it to Elaichi support.'
    case 'unauthorized':
    case 'http_401':
      return 'Check ELAICHI_API_TOKEN.'
    case 'permission_required':
    case 'forbidden':
    case 'http_403':
      return 'The token\'s owner lacks a permission, or the connector is restricted for them. Read the message above.'
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
export async function fetchPipedreamAccounts(env: PdEnv, fetchFn: typeof fetch = fetch, opts: { sleep?: (ms: number) => Promise<void>; warn?: (s: string) => void } = {}): Promise<PdAccount[]> {
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
    const url = `${base}${path}?${q}`
    const init = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    let res = await fetchFn(url, init)
    if (res.status === 429) {
      await (opts.sleep ?? sleepMs)(retryWaitMs(Number(res.headers.get('Retry-After')) || undefined))
      res = await fetchFn(url, init)
    }
    if (!res.ok) throw new Error(`Pipedream answered ${res.status} on GET ${path}.`)
    // This body carries credentials: a parse error message could quote it, so only the path is named.
    try {
      return JSON.parse(await res.text()) as { data?: unknown; page_info?: { end_cursor?: string | null } }
    } catch {
      throw new Error(`Pipedream sent an answer that is not JSON on GET ${path}.`)
    }
  }

  const accounts: PdAccount[] = []
  const seen = new Set<string>()
  let after: string | undefined
  let finished = false
  // ponytail: at most 200 pages of 100 (20,000 accounts); a bigger workspace gets a warning, then the first 20,000. Raise it or stream if that bites.
  for (let page = 0; page < 200; page++) {
    const j = await get('/accounts', { limit: '100', ...(after ? { after } : {}) })
    const data = Array.isArray(j.data) ? (j.data.filter(isRecord) as PdAccount[]) : []
    accounts.push(...data)
    const next = j.page_info?.end_cursor ?? undefined
    if (data.length === 0 || !next || seen.has(next)) {
      finished = true
      break
    }
    seen.add(next)
    after = next
  }
  if (!finished) opts.warn?.(`Warning: stopped after 200 pages of Pipedream accounts (${accounts.length}). Accounts beyond that are not in this run.`)
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i] as PdAccount
    if (a.id && !credentialsOf(a) && !a.dead) {
      try {
        const j = await get(`/accounts/${encodeURIComponent(a.id)}`, {})
        if (isRecord(j.data)) accounts[i] = { ...a, ...(j.data as PdAccount) }
      } catch (e) {
        // This account only: keep its id, say why, and go on with the rest.
        accounts[i] = { ...a, fetch_error: (e as Error).message }
      }
    }
  }
  return accounts
}
