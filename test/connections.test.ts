// The connections command: Pipedream connected accounts → Elaichi connections, without ever writing a secret.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { accountsFromJson, applyConnections, candidateSlugs, type ConnPlan, type ConnResult, fetchPipedreamAccounts } from '../src/connections.ts'

const FIX = join(import.meta.dir, 'fixtures', 'connections')
const ACCOUNTS = join(FIX, 'accounts.json')
const MAP = join(FIX, 'map.json')
const SENTINEL = 'SENTINEL_SECRET'
const ENV = { ELAICHI_API_TOKEN: 'elch_org_test_token' }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
/** Elaichi's 201: the connection is under `connection`. */
const created = (id: string) => json({ connection: { id, connector_slug: 'x', status: 'active', credential_tested: true } }, 201)
const oauth2Fields = [
  { name: 'access_token', label: 'Access token', required: true, secret: true },
  { name: 'refresh_token', label: 'Refresh token', required: false, secret: true },
  { name: 'expires_at', label: 'Expires at', required: false, secret: false },
  { name: 'scope', label: 'Scope', required: false, secret: false },
]
const CONNECTORS: Record<string, unknown> = {
  slack: { slug: 'slack', auth_formats: ['oauth2'], auth_fields: { oauth2: oauth2Fields } },
  googlesheets: { slug: 'googlesheets', auth_formats: ['oauth2'], auth_fields: { oauth2: oauth2Fields } },
  sendgrid: { slug: 'sendgrid', auth_formats: ['api_key'], auth_fields: { api_key: [{ name: 'api_key', label: 'API key', required: true, secret: true }] } },
  // Basic auth comes in as api_key with username and password fields.
  'acme-billing': {
    slug: 'acme-billing',
    auth_formats: ['api_key'],
    auth_fields: { api_key: [{ name: 'username', label: 'Username', required: true, secret: false }, { name: 'password', label: 'Password', required: true, secret: true }] },
  },
  'acme-crm': {
    slug: 'acme-crm',
    auth_formats: ['api_key'],
    auth_fields: { api_key: [{ name: 'api_token', label: 'API token', required: true, secret: true }, { name: 'domain', label: 'Domain', required: true, secret: false }] },
  },
}
const ORG_OAUTH_APPS: Record<string, unknown> = {
  slack: { oauth_app_mode: 'byoa', client_id: 'client_acme_slack', has_client_secret: true, scope: 'chat:write' },
  googlesheets: { oauth_app_mode: 'platform_default', client_id: 'elaichi_platform_client', has_client_secret: true },
}

type Post = (body: { connector_slug: string; credentials: { values: Record<string, string> } }, n: number) => Response
interface Call {
  method: string
  url: string
  body?: string
  headers: Record<string, string>
}

/** A fake Elaichi API. `post` answers POST /connection; the default creates the connection. */
function elaichi(post: Post = (b, n) => created(`conn_${n}_${b.connector_slug}`), oauthApps: Record<string, unknown> = ORG_OAUTH_APPS, connectors: Record<string, unknown> = CONNECTORS) {
  const calls: Call[] = []
  let n = 0
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined, headers: (init?.headers ?? {}) as Record<string, string> })
    const path = new URL(url).pathname
    let m = /^\/connector\/([^/]+)\/oauth-app$/.exec(path)
    if (m?.[1] && method === 'GET') {
      const app = oauthApps[m[1]]
      if (app === 'forbidden') return json({ error: { code: 'permission_required', message: 'You need connector:manage.' } }, 403)
      return app ? json(app) : json({ error: { code: 'not_found', message: 'No OAuth app' } }, 404)
    }
    m = /^\/connector\/([^/]+)$/.exec(path)
    if (m?.[1] && method === 'GET') return connectors[m[1]] ? json(connectors[m[1]]) : json({ error: { code: 'not_found', message: 'No such connector' } }, 404)
    if (path === '/connection' && method === 'POST') return post(JSON.parse(String(init?.body)), ++n)
    return json({ error: { code: 'not_found' } }, 404)
  }) as unknown as typeof fetch
  return { f, calls, posts: () => calls.filter(c => c.method === 'POST') }
}

const capture = () => {
  const lines: string[] = []
  return { lines, log: (s: string) => lines.push(s) }
}
const outDir = () => mkdtempSync(join(tmpdir(), 'p2e-conn-'))
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T
const byId = (plan: ConnPlan) => Object.fromEntries(plan.accounts.map(a => [a.pipedream_account_id, a]))

describe('connections dry run', () => {
  test('classifies each account and creates nothing', async () => {
    const out = outDir()
    const api = elaichi()
    const { lines, log } = capture()
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--out', out], ENV, log, api.f)).toBe(0)
    expect(api.posts()).toEqual([])
    const plan = readJson<ConnPlan>(join(out, 'connections-plan.json'))
    const a = byId(plan)
    expect(a.apn_slack1).toMatchObject({ status: 'importable', connector_slug: 'slack', authentication_method: 'oauth2', fields: ['access_token', 'expires_at', 'refresh_token', 'scope'] })
    expect(a.apn_sheets1).toMatchObject({ status: 'org_oauth_app_needed', connector_slug: 'googlesheets' })
    expect(a.apn_github1?.status).toBe('reconnect')
    expect(a.apn_dead1?.status).toBe('reconnect')
    expect(a.apn_sendgrid1).toMatchObject({ status: 'importable', authentication_method: 'api_key', fields: ['api_key'] })
    expect(a.apn_acme1).toMatchObject({ status: 'needs_mapping', connector_slug: 'acme-crm', pipedream_keys: ['subdomain', 'token'], elaichi_fields: { api_key: ['api_token', 'domain'] } })
    expect(a.apn_trello1?.status).toBe('no_connector')
    expect(a.apn_basic1).toMatchObject({ status: 'importable', connector_slug: 'acme-billing', authentication_method: 'api_key', fields: ['password', 'username'] })
    expect(plan.summary).toEqual({ importable: 3, org_oauth_app_unknown: 0, org_oauth_app_needed: 1, needs_mapping: 1, no_connector: 1, restricted: 0, reconnect: 2 })
    expect(lines.join('\n')).toContain('| slack | Slack — acme | slack | importable |')
    expect(lines.join('\n')).toContain('Dry run: nothing was created')
    expect(existsSync(join(out, 'connections-result.json'))).toBe(false)
  })
  test('never sends an organization header: the token names the organization', async () => {
    const api = elaichi()
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', outDir()], ENV, () => {}, api.f)
    for (const c of api.calls) {
      expect(c.headers.Authorization).toBe('Bearer elch_org_test_token')
      expect(Object.keys(c.headers).some(h => h.toLowerCase() === 'x-organization-id')).toBe(false)
    }
  })
  test('an organization OAuth app with a different client id is not the client that issued the token', async () => {
    const out = outDir()
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out], ENV, () => {}, elaichi(undefined, { ...ORG_OAUTH_APPS, slack: { oauth_app_mode: 'byoa', client_id: 'someone_else' } }).f)
    expect(byId(readJson<ConnPlan>(join(out, 'connections-plan.json'))).apn_slack1?.status).toBe('org_oauth_app_needed')
  })
  test('an OAuth connector that lists no oauth2 fields needs mapping: nothing is sent without the field list', async () => {
    const out = outDir()
    const api = elaichi(undefined, ORG_OAUTH_APPS, { ...CONNECTORS, slack: { slug: 'slack', auth_formats: ['oauth2'], auth_fields: {} } })
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, () => {}, api.f)
    expect(byId(readJson<ConnPlan>(join(out, 'connections-plan.json'))).apn_slack1?.status).toBe('needs_mapping')
    expect(api.posts().map(c => JSON.parse(c.body as string).connector_slug)).not.toContain('slack')
  })
  test('an account with no id is a reconnect, so two accounts never share a resume key', async () => {
    const dir = outDir()
    const file = join(dir, 'acc.json')
    writeFileSync(file, JSON.stringify({ data: [{ name: 'No id', app: { name_slug: 'sendgrid' }, credentials: { api_key: 'SENTINEL_SECRET_noid' } }] }))
    const api = elaichi()
    await main(['connections', '--accounts-file', file, '--out', dir, '--apply'], ENV, () => {}, api.f)
    expect(readJson<ConnPlan>(join(dir, 'connections-plan.json')).accounts[0]?.status).toBe('reconnect')
    expect(api.posts()).toEqual([])
  })
  test('--map names the connector, method and fields', async () => {
    const out = outDir()
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--map', MAP, '--out', out], ENV, () => {}, elaichi().f)).toBe(0)
    expect(byId(readJson<ConnPlan>(join(out, 'connections-plan.json'))).apn_acme1).toMatchObject({ status: 'importable', authentication_method: 'api_key', fields: ['api_token', 'domain'] })
  })
  test('candidate slugs: exact, hyphen, no separator, the catalog, then --map wins', () => {
    expect(candidateSlugs('google_sheets', {})).toEqual(['google_sheets', 'google-sheets', 'googlesheets'])
    expect(candidateSlugs('github', {})).toContain('github-mcp')
    expect(candidateSlugs('slack_v2', {})).toEqual(['slack_v2', 'slack-v2', 'slackv2', 'slack'])
    expect(candidateSlugs('google_sheets', { google_sheets: 'sheets' })).toEqual(['sheets'])
  })
  test('reads one page, an array of pages, or an array of accounts', () => {
    const acc = { id: 'apn_1', app: { name: 'Slack' } }
    expect(accountsFromJson({ data: [acc] })).toHaveLength(1)
    expect(accountsFromJson([{ data: [acc] }, { data: [{ ...acc, id: 'apn_2' }, { ...acc, id: 'apn_3' }] }])).toHaveLength(3)
    expect(accountsFromJson([acc, { ...acc, id: 'apn_2' }])).toHaveLength(2)
    expect(() => accountsFromJson({ accounts: [] })).toThrow()
  })
  test('needs an Elaichi token, and refuses a positional argument', async () => {
    expect(await main(['connections', '--accounts-file', ACCOUNTS], {}, () => {}, elaichi().f)).toBe(1)
    const { lines, log } = capture()
    expect(await main(['connections', ACCOUNTS, '--accounts-file', ACCOUNTS], ENV, log, elaichi().f)).toBe(1)
    expect(lines.join('\n')).toContain('connections takes no folder or file')
  })
})

describe('connections --apply', () => {
  test('posts each importable account once, with the Elaichi field names, and writes the result', async () => {
    const out = outDir()
    const api = elaichi()
    const { lines, log } = capture()
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--map', MAP, '--out', out, '--apply'], ENV, log, api.f)).toBe(0)
    const bodies = api.posts().map(c => JSON.parse(c.body as string))
    expect(bodies).toEqual([
      {
        connector_slug: 'slack',
        name: 'Slack — acme',
        credentials: { authentication_method: 'oauth2', values: { access_token: 'SENTINEL_SECRET_slack_access', refresh_token: 'SENTINEL_SECRET_slack_refresh', expires_at: '2026-12-01T10:00:00.000Z', scope: 'chat:write channels:read' } },
      },
      { connector_slug: 'sendgrid', name: 'SendGrid', credentials: { authentication_method: 'api_key', values: { api_key: 'SENTINEL_SECRET_sendgrid_key' } } },
      { connector_slug: 'acme-crm', name: 'Acme CRM', credentials: { authentication_method: 'api_key', values: { api_token: 'SENTINEL_SECRET_acme_token', domain: 'acme-eu' } } },
      { connector_slug: 'acme-billing', name: 'Acme Billing', credentials: { authentication_method: 'api_key', values: { username: 'ops@acme.test', password: 'SENTINEL_SECRET_billing_password' } } },
    ])
    const results = readJson<ConnResult[]>(join(out, 'connections-result.json'))
    expect(results.every(r => r.credential_tested === true)).toBe(true)
    expect(results.map(r => [r.pipedream_account_id, r.ok, r.connection_id])).toEqual([
      ['apn_slack1', true, 'conn_1_slack'],
      ['apn_sendgrid1', true, 'conn_2_sendgrid'],
      ['apn_acme1', true, 'conn_3_acme-crm'],
      ['apn_basic1', true, 'conn_4_acme-billing'],
    ])
    expect(lines.join('\n')).toContain('Created connection conn_1_slack')
  })

  const applyWith = async (post: Post, extra: string[] = []) => {
    const out = outDir()
    const api = elaichi(post)
    const { lines, log } = capture()
    const code = await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply', ...extra], ENV, log, api.f)
    return { code, api, lines, out, results: readJson<ConnResult[]>(join(out, 'connections-result.json')) }
  }
  const errOn = (slug: string, status: number, error: Record<string, unknown>, headers?: Record<string, string>): Post => (b, n) =>
    b.connector_slug === slug ? json({ error }, status, headers) : created(`conn_${n}`)

  test('org_oauth_app_required', async () => {
    const { code, results, lines } = await applyWith(errOn('slack', 409, { code: 'org_oauth_app_required', message: 'Set your own OAuth app for slack first.' }))
    expect(code).toBe(2)
    expect(results.find(r => r.connector_slug === 'slack')).toMatchObject({ ok: false, error_code: 'org_oauth_app_required' })
    expect(results.find(r => r.connector_slug === 'sendgrid')?.ok).toBe(true)
    expect(lines.join('\n')).toContain('organization\'s own OAuth app')
  })
  test('credential_test_failed', async () => {
    const { results } = await applyWith(errOn('sendgrid', 422, { code: 'credential_test_failed', message: 'SendGrid refused the key.' }))
    expect(results.find(r => r.connector_slug === 'sendgrid')).toMatchObject({ ok: false, error_code: 'credential_test_failed' })
  })
  test('invalid_credentials names the field', async () => {
    const { results, lines } = await applyWith(errOn('sendgrid', 422, { code: 'invalid_credentials', message: 'api_key is not valid.', details: { field: 'credentials.values.api_key' } }))
    expect(results.find(r => r.connector_slug === 'sendgrid')).toMatchObject({ ok: false, error_code: 'invalid_credentials', field: 'credentials.values.api_key' })
    expect(lines.join('\n')).toContain('(field credentials.values.api_key)')
  })
  test('a bare { code } error body is read too', async () => {
    const { results, lines } = await applyWith((b, n) => (b.connector_slug === 'sendgrid' ? json({ code: 'unsupported_authentication_method', message: 'No api_key here.' }, 422) : created(`conn_${n}`)))
    expect(results.find(r => r.connector_slug === 'sendgrid')).toMatchObject({ ok: false, error_code: 'unsupported_authentication_method' })
    expect(lines.join('\n')).toContain('Pick another "authentication_method"')
  })
  test('503 connection_import_unavailable stops the run and says so', async () => {
    const { results, api, lines } = await applyWith(() => json({ error: { code: 'connection_import_unavailable', message: 'Connection import is not available yet.' } }, 503))
    expect(api.posts()).toHaveLength(1)
    expect(results.map(r => r.error_code)).toEqual(['connection_import_unavailable', 'skipped', 'skipped'])
    expect(lines.join('\n')).toContain('Elaichi cannot import connections yet')
  })
  test('428 step_up_required stops the run and asks to report it', async () => {
    const { results, api, lines } = await applyWith(() => json({ error: { code: 'step_up_required', message: 'Re-verify.' } }, 428))
    expect(api.posts()).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, error_code: 'step_up_required' })
    expect(lines.join('\n')).toContain('report it to Elaichi support')
  })
  test('org OAuth app unknown (403 on oauth-app) is not guessed: the dry run says so and --apply sends it', async () => {
    const out = outDir()
    const api = elaichi(undefined, { ...ORG_OAUTH_APPS, slack: 'forbidden' })
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, () => {}, api.f)
    expect(byId(readJson<ConnPlan>(join(out, 'connections-plan.json'))).apn_slack1?.status).toBe('org_oauth_app_unknown')
    expect(api.posts().map(c => JSON.parse(c.body as string).connector_slug)).toContain('slack')
  })
  test('401 stops the run: later accounts are not sent', async () => {
    const { results, api } = await applyWith(() => json({ error: { code: 'unauthorized', message: 'Bad token' } }, 401))
    expect(api.posts()).toHaveLength(1)
    expect(results.map(r => r.error_code)).toEqual(['unauthorized', 'skipped', 'skipped'])
  })
  test('429 waits for Retry-After once, then sends again', async () => {
    let first = true
    const post: Post = (b, n) => {
      if (first) {
        first = false
        return json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'Retry-After': '0.001' })
      }
      return created(`conn_${n}`)
    }
    const { results, api } = await applyWith(post)
    expect(api.posts()).toHaveLength(4)
    expect(results.every(r => r.ok)).toBe(true)
  })
  test('a second --apply skips what the first created, retries the rest, and keeps the old ids', async () => {
    const { out, results: first } = await applyWith(errOn('slack', 409, { code: 'org_oauth_app_required', message: 'Set your own OAuth app.' }), ['--map', MAP])
    expect(first.map(r => r.ok)).toEqual([false, true, true, true])
    const api = elaichi()
    const { lines, log } = capture()
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--map', MAP, '--out', out, '--apply'], ENV, log, api.f)).toBe(0)
    expect(api.posts().map(c => JSON.parse(c.body as string).connector_slug)).toEqual(['slack'])
    expect(lines.join('\n')).toContain('Skipping 3 accounts')
    const merged = readJson<ConnResult[]>(join(out, 'connections-result.json'))
    expect(merged.map(r => [r.pipedream_account_id, r.ok, r.connection_id])).toEqual([
      ['apn_slack1', true, 'conn_1_slack'],
      ['apn_sendgrid1', true, first[1]?.connection_id],
      ['apn_acme1', true, first[2]?.connection_id],
      ['apn_basic1', true, first[3]?.connection_id],
    ])
  })
  test('a pending marker is in the result file while each POST is in flight', async () => {
    const out = outDir()
    let seenDuringSecond: ConnResult[] | undefined
    const api = elaichi((_, n) => {
      if (n === 2) seenDuringSecond = readJson<ConnResult[]>(join(out, 'connections-result.json'))
      return created(`conn_${n}`)
    })
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, () => {}, api.f)
    expect(seenDuringSecond?.map(r => [r.pipedream_account_id, r.error_code ?? r.connection_id])).toEqual([
      ['apn_slack1', 'conn_1'],
      ['apn_sendgrid1', 'pending'],
    ])
  })
  test('a network error or a 5xx is an unknown outcome: not sent again until --retry-unknown', async () => {
    const out = outDir()
    const first = elaichi((b, n) => {
      if (b.connector_slug === 'sendgrid') return json({ error: { code: 'bad_gateway', message: 'Boom' } }, 502)
      if (b.connector_slug === 'acme-billing') throw new Error('socket hang up')
      return created(`conn_${n}`)
    })
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, () => {}, first.f)
    const r1 = readJson<ConnResult[]>(join(out, 'connections-result.json'))
    expect(r1.filter(r => r.error_code === 'unknown_outcome').map(r => r.pipedream_account_id)).toEqual(['apn_sendgrid1', 'apn_basic1'])
    const again = elaichi()
    const { lines, log } = capture()
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, log, again.f)
    expect(again.posts()).toEqual([])
    expect(lines.join('\n')).toContain('Check Elaichi for a sendgrid connection named "SendGrid" first')
    const retry = elaichi()
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply', '--retry-unknown'], ENV, () => {}, retry.f)
    expect(retry.posts().map(c => JSON.parse(c.body as string).connector_slug)).toEqual(['sendgrid', 'acme-billing'])
  })
  test('a crash between the POST and the write leaves pending, which a re-run treats as unknown', async () => {
    const out = outDir()
    writeFileSync(join(out, 'connections-result.json'), JSON.stringify([{ pipedream_account_id: 'apn_slack1', pipedream_app: 'slack', connector_slug: 'slack', connection_name: 'Slack — acme', ok: false, error_code: 'pending' }]))
    const api = elaichi()
    await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, () => {}, api.f)
    expect(api.posts().map(c => JSON.parse(c.body as string).connector_slug)).not.toContain('slack')
  })
  test('--force keeps the earlier result as a timestamped backup', async () => {
    const { out } = await applyWith((_, n) => created(`conn_${n}`))
    const before = readFileSync(join(out, 'connections-result.json'), 'utf8')
    const { lines, log } = capture()
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply', '--force'], ENV, log, elaichi().f)).toBe(0)
    const backups = readdirSync(out).filter(f => /^connections-result\..+\.json$/.test(f))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(out, backups[0] as string), 'utf8')).toBe(before)
    expect(lines.join('\n')).toContain('moved the earlier result')
  })
  test('credential_test_timeout says to try later', async () => {
    const { results, lines } = await applyWith(errOn('sendgrid', 422, { code: 'credential_test_timeout', message: 'Too slow.' }))
    expect(results.find(r => r.connector_slug === 'sendgrid')?.error_code).toBe('credential_test_timeout')
    expect(lines.join('\n')).toContain('took too long')
  })
})

describe('no secret leaves memory except in POST /connection', () => {
  const filesIn = (dir: string) => readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8'))
  test('dry run, apply success and an error that echoes the secret', async () => {
    // An Elaichi error that quotes what it was sent: the scrubber must still keep it out of logs and files.
    const echo: Post = (b, n) => (b.connector_slug === 'sendgrid' ? json({ error: { code: 'invalid_credentials', message: `bad key ${b.credentials.values.api_key}`, details: { field: 'api_key' } } }, 400) : created(`conn_${n}`))
    for (const [args, post] of [
      [[], undefined],
      [['--apply'], undefined],
      [['--apply', '--json'], echo],
      [['--json'], undefined],
    ] as [string[], Post | undefined][]) {
      const out = outDir()
      const api = elaichi(post)
      const { lines, log } = capture()
      await main(['connections', '--accounts-file', ACCOUNTS, '--map', MAP, '--out', out, ...args], ENV, log, api.f)
      if (args.includes('--apply')) expect(api.posts().some(c => c.body?.includes(SENTINEL))).toBe(true)
      expect(lines.join('\n')).not.toContain(SENTINEL)
      expect(lines.join('\n')).not.toContain(ENV.ELAICHI_API_TOKEN)
      for (const text of filesIn(out)) {
        expect(text).not.toContain(SENTINEL)
        expect(text).not.toContain('client_acme')
      }
    }
  })
  test('apply results keep Elaichi\'s code and message, never the raw body (checked without the scrubber)', async () => {
    const api = elaichi(() => new Response(`<html>upstream echoed ${SENTINEL}_x</html>`, { status: 502 }))
    const send = { connector_slug: 'sendgrid', credentials: { authentication_method: 'api_key', values: { api_key: `${SENTINEL}_x` } } }
    const [r] = await applyConnections([{ item: { pipedream_account_id: 'apn_1', pipedream_app: 'sendgrid', status: 'importable', reasons: [] }, send }], { token: 't', fetch: api.f })
    expect(r).toMatchObject({ ok: false, error_code: 'unknown_outcome', error: '502' })
    expect(JSON.stringify(r)).not.toContain(SENTINEL)
  })
  test('a Pipedream answer that is not JSON is not quoted back', async () => {
    const f = (async (url: string) =>
      new URL(url).pathname === '/v1/oauth/token' ? json({ access_token: 'pd_access' }) : new Response(`{"data":[{"credentials":{"api_key":"${SENTINEL}_y"`, { status: 200 })) as unknown as typeof fetch
    const { lines, log } = capture()
    expect(await main(['connections', '--out', outDir()], { ...ENV, PIPEDREAM_CLIENT_ID: 'id', PIPEDREAM_CLIENT_SECRET: `${SENTINEL}_client` }, log, f)).toBe(1)
    expect(lines.join('\n')).toContain('not JSON')
    expect(lines.join('\n')).not.toContain(SENTINEL)
  })
  test('a broken accounts file is not quoted back', async () => {
    const dir = outDir()
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, `{ "data": [ { "credentials": { "api_key": "${SENTINEL}_x" } ] `)
    const { lines, log } = capture()
    expect(await main(['connections', '--accounts-file', bad, '--out', dir], ENV, log, elaichi().f)).toBe(1)
    expect(lines.join('\n')).not.toContain(SENTINEL)
  })
})

describe('live fetch from Pipedream', () => {
  const pipedream = () => {
    const calls: string[] = []
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url)
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`)
      if (u.pathname === '/v1/oauth/token') return json({ access_token: 'pd_access', token_type: 'Bearer', expires_in: 3600 })
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer (pd_access|pd_key)$/)
      if (u.pathname === '/v1/accounts' && !u.searchParams.get('after'))
        return json({ page_info: { end_cursor: 'c1' }, data: [{ id: 'apn_a', app: { name: 'Slack' }, credentials: { oauth_access_token: 'SENTINEL_SECRET_a' } }] })
      if (u.pathname === '/v1/accounts' && u.searchParams.get('after') === 'c1') return json({ page_info: { end_cursor: 'c2' }, data: [{ id: 'apn_b', app: { name: 'SendGrid' } }] })
      if (u.pathname === '/v1/accounts') return json({ page_info: { end_cursor: null }, data: [] })
      if (u.pathname === '/v1/accounts/apn_b') return json({ data: { id: 'apn_b', app: { name: 'SendGrid' }, credentials: { api_key: 'SENTINEL_SECRET_b' } } })
      return json({}, 404)
    }) as unknown as typeof fetch
    return { f, calls }
  }
  test('OAuth client: token, every page, then one account call for an account listed without credentials', async () => {
    const pd = pipedream()
    const accounts = await fetchPipedreamAccounts({ PIPEDREAM_CLIENT_ID: 'id', PIPEDREAM_CLIENT_SECRET: 'secret' }, pd.f)
    expect(accounts.map(a => [a.id, Object.keys(a.credentials ?? {})])).toEqual([
      ['apn_a', ['oauth_access_token']],
      ['apn_b', ['api_key']],
    ])
    expect(pd.calls).toEqual([
      'POST /v1/oauth/token',
      'GET /v1/accounts?limit=100&include_credentials=true',
      'GET /v1/accounts?limit=100&after=c1&include_credentials=true',
      'GET /v1/accounts?limit=100&after=c2&include_credentials=true',
      'GET /v1/accounts/apn_b?include_credentials=true',
    ])
  })
  test('API key needs the workspace id, and sends it as org_id', async () => {
    await expect(fetchPipedreamAccounts({ PIPEDREAM_API_KEY: 'pd_key' }, pipedream().f)).rejects.toThrow('PIPEDREAM_ORG_ID')
    const pd = pipedream()
    await fetchPipedreamAccounts({ PIPEDREAM_API_KEY: 'pd_key', PIPEDREAM_ORG_ID: 'o_abc' }, pd.f)
    expect(pd.calls[0]).toBe('GET /v1/accounts?limit=100&include_credentials=true&org_id=o_abc')
  })
  test('with no accounts file and no Pipedream credentials, the command says what to set', async () => {
    const { lines, log } = capture()
    expect(await main(['connections', '--out', outDir()], ENV, log, elaichi().f)).toBe(1)
    expect(lines.join('\n')).toContain('PIPEDREAM_CLIENT_ID')
  })
})

describe('the convert flow points at the connections command', () => {
  test('report.md, migration-plan.json and the console say how to move accounts', async () => {
    const out = outDir()
    const { lines, log } = capture()
    expect(await main([join(import.meta.dir, 'fixtures', 'schedule-slack.json'), '--out', out], {}, log)).toBe(0)
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('Run `pipedream-to-elaichi connections`')
    expect(readJson<{ connections: string }>(join(out, 'migration-plan.json')).connections).toContain('pipedream-to-elaichi connections')
    expect(lines.join('\n')).toContain('pipedream-to-elaichi connections')
  })
})

const errOnAll = (status: number, error: Record<string, unknown>): Post => () => json({ error }, status)

describe('review fixes', () => {
  const run = async (args: string[], api = elaichi(), env: Record<string, string | undefined> = ENV) => {
    const out: string[] = []
    const err: string[] = []
    const outDirPath = outDir()
    const code = await main(['connections', ...args, '--out', outDirPath], env, s => out.push(s), api.f, s => err.push(s))
    return { code, out, err, dir: outDirPath, api }
  }
  const posted = (api: ReturnType<typeof elaichi>) => api.posts().map(c => JSON.parse(c.body as string).connector_slug)

  test('1 --json prints valid JSON only on stdout; the rest goes to stderr', async () => {
    const dry = await run(['--accounts-file', ACCOUNTS, '--json'])
    expect(dry.out).toHaveLength(1)
    expect(() => JSON.parse(dry.out[0] as string)).not.toThrow()
    expect(dry.err.join('\n')).toContain('Warning')
    const apply = await run(['--accounts-file', ACCOUNTS, '--json', '--apply'])
    expect(apply.out).toHaveLength(1)
    expect(JSON.parse(apply.out[0] as string).ok).toBe(true)
    expect(apply.err.join('\n')).toContain('| Pipedream app |')
  })

  test('2 a restricted connector is its own status, and a per-connector 403 fails only that account', async () => {
    const api = elaichi(undefined, ORG_OAUTH_APPS, { ...CONNECTORS, sendgrid: { ...(CONNECTORS.sendgrid as object), restricted: true } })
    const r = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], api)
    expect(byId(readJson<ConnPlan>(join(r.dir, 'connections-plan.json'))).apn_sendgrid1?.status).toBe('restricted')
    expect(posted(api)).not.toContain('sendgrid')
    const only = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi((b, n) => (b.connector_slug === 'slack' ? json({ error: { code: 'forbidden', message: 'This connector is restricted for your account' } }, 403) : created(`conn_${n}`))))
    const res = readJson<ConnResult[]>(join(only.dir, 'connections-result.json'))
    expect(res.map(x => x.ok)).toEqual([false, true, true, true])
    const whole = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi(() => json({ error: { code: 'permission_required', message: 'Need connection:create' } }, 403)))
    expect(readJson<ConnResult[]>(join(whole.dir, 'connections-result.json')).map(x => x.error_code)).toEqual(['permission_required', 'skipped', 'skipped', 'skipped'])
  })

  test('3 the scrubber works on values, so a secret like "false" never damages the JSON', async () => {
    const dir = outDir()
    const file = join(dir, 'acc.json')
    writeFileSync(file, JSON.stringify({ data: [{ id: 'apn_f', name: 'SendGrid', app: { name_slug: 'sendgrid' }, credentials: { api_key: 'false' } }] }))
    const api = elaichi(() => json({ error: { code: 'credential_test_failed', message: 'refused false' } }, 422))
    await main(['connections', '--accounts-file', file, '--out', dir, '--apply'], ENV, () => {}, api.f, () => {})
    const [r] = readJson<ConnResult[]>(join(dir, 'connections-result.json'))
    expect(r?.ok).toBe(false)
    expect(r?.error).toContain('[redacted]')
    expect(readFileSync(join(dir, 'connections-result.json'), 'utf8')).not.toMatch(/"ok": \[redacted\]/)
  })

  test('4 a repeated account id is sent once', async () => {
    const dir = outDir()
    const file = join(dir, 'acc.json')
    const acc = { id: 'apn_d', name: 'SendGrid', app: { name_slug: 'sendgrid' }, credentials: { api_key: 'SENTINEL_SECRET_d' } }
    writeFileSync(file, JSON.stringify([{ data: [acc] }, { data: [acc] }]))
    const api = elaichi()
    await main(['connections', '--accounts-file', file, '--out', dir, '--apply'], ENV, () => {}, api.f, () => {})
    expect(posted(api)).toEqual(['sendgrid'])
  })

  test('5 --map fields accept Pipedream\'s own OAuth key names', async () => {
    const dir = outDir()
    const map = join(dir, 'm.json')
    writeFileSync(map, JSON.stringify({ slack: { connector: 'slack', fields: { oauth_access_token: 'access_token', oauth_refresh_token: 'refresh_token' } } }))
    const r = await run(['--accounts-file', ACCOUNTS, '--map', map])
    expect(byId(readJson<ConnPlan>(join(r.dir, 'connections-plan.json'))).apn_slack1).toMatchObject({ status: 'importable', fields: expect.arrayContaining(['access_token', 'refresh_token']) })
  })

  test('6 the result file is written by rename: no temp file is left', async () => {
    const r = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'])
    expect(readdirSync(r.dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(existsSync(join(r.dir, 'connections-result.json'))).toBe(true)
  })

  describe('7 Pipedream fetch', () => {
    test('retries once on 429, records a failed per-account GET, and warns at the page cap', async () => {
      let limited = true
      const f = (async (url: string) => {
        const u = new URL(url)
        if (u.pathname === '/v1/oauth/token') return json({ access_token: 'pd_access' })
        if (u.pathname === '/v1/accounts' && limited) {
          limited = false
          return json({}, 429, { 'Retry-After': '1' })
        }
        if (u.pathname === '/v1/accounts') return json({ page_info: { end_cursor: null }, data: [{ id: 'apn_x', app: { name: 'Slack' } }] })
        return json({ error: 'nope' }, 404)
      }) as unknown as typeof fetch
      const waits: number[] = []
      const accounts = await fetchPipedreamAccounts({ PIPEDREAM_CLIENT_ID: 'id', PIPEDREAM_CLIENT_SECRET: 's' }, f, { sleep: async ms => void waits.push(ms) })
      expect(waits).toEqual([1000])
      expect(accounts[0]).toMatchObject({ id: 'apn_x', fetch_error: 'Pipedream answered 404 on GET /accounts/apn_x.' })
      const out = outDir()
      const file = join(out, 'a.json')
      writeFileSync(file, JSON.stringify({ data: accounts }))
      await main(['connections', '--accounts-file', file, '--out', out], ENV, () => {}, elaichi().f, () => {})
      const item = readJson<ConnPlan>(join(out, 'connections-plan.json')).accounts[0]
      expect(item).toMatchObject({ pipedream_account_id: 'apn_x', status: 'reconnect' })
    })
    test('warns on stderr when the 200-page cap is hit', async () => {
      let n = 0
      const f = (async (url: string) => {
        if (new URL(url).pathname === '/v1/oauth/token') return json({ access_token: 'pd_access' })
        n++
        return json({ page_info: { end_cursor: `c${n}` }, data: [{ id: `apn_${n}`, app: { name: 'Slack' }, credentials: { oauth_access_token: 'SENTINEL_SECRET_p' } }] })
      }) as unknown as typeof fetch
      const warnings: string[] = []
      await fetchPipedreamAccounts({ PIPEDREAM_CLIENT_ID: 'id', PIPEDREAM_CLIENT_SECRET: 's' }, f, { warn: s => warnings.push(s) })
      expect(warnings.join('')).toContain('200 pages')
    })
  })

  describe('8 error help', () => {
    test('validation_error shows the field', async () => {
      const r = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi(errOnAll(400, { code: 'validation_error', message: 'Bad key.', details: { field: 'credentials.values.x' } })))
      expect(r.out.join('\n')).toContain('(field credentials.values.x)')
      expect(r.out.join('\n')).toContain('Fix the --map entry')
    })
    test('a coded 500 internal_error is a plain failure, not unknown_outcome', async () => {
      const r = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi(errOnAll(500, { code: 'internal_error', message: 'Boom' })))
      expect(readJson<ConnResult[]>(join(r.dir, 'connections-result.json')).every(x => x.error_code === 'internal_error')).toBe(true)
    })
    test('a 404 on the oauth-app read is worded apart from connector:manage', async () => {
      const r = await run(['--accounts-file', ACCOUNTS], elaichi(undefined, { ...ORG_OAUTH_APPS, slack: undefined }))
      const reason = byId(readJson<ConnPlan>(join(r.dir, 'connections-plan.json'))).apn_slack1?.reasons.join(' ')
      expect(reason).toContain('no organization OAuth app to read')
      expect(reason).not.toContain('connector:manage')
    })
    test('503 platform_connections_stopped stops the run with its own text; another 503 says unavailable', async () => {
      const a = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi(errOnAll(503, { code: 'platform_connections_stopped', message: 'Paused.' })))
      expect(a.out.join('\n')).toContain('paused connection changes')
      expect(a.out.join('\n')).not.toContain('cannot import connections yet')
      const b = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi(errOnAll(503, { message: 'Down.' })))
      expect(b.out.join('\n')).toContain('Elaichi is unavailable')
    })
  })

  test('9 --map oauth2 works for a key-based account whose fields map to access_token', async () => {
    const dir = outDir()
    const map = join(dir, 'm.json')
    writeFileSync(map, JSON.stringify({ acme_crm: { connector: 'acme-crm', authentication_method: 'oauth2', fields: { token: 'access_token' } } }))
    const api = elaichi(undefined, { ...ORG_OAUTH_APPS, 'acme-crm': { oauth_app_mode: 'byoa', client_id: 'c' } }, { ...CONNECTORS, 'acme-crm': { slug: 'acme-crm', auth_formats: ['oauth2'], auth_fields: { oauth2: oauth2Fields } } })
    const r = await run(['--accounts-file', ACCOUNTS, '--map', map], api)
    expect(byId(readJson<ConnPlan>(join(r.dir, 'connections-plan.json'))).apn_acme1).toMatchObject({ status: 'importable', authentication_method: 'oauth2', fields: ['access_token'] })
  })

  test('10 a 201 with post_install_error is created but needs repair', async () => {
    const r = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi((b, n) => (b.connector_slug === 'sendgrid' ? json({ connection: { id: `conn_${n}`, status: 'post_install_error' } }, 201) : created(`conn_${n}`))))
    expect(r.code).toBe(2)
    const x = readJson<ConnResult[]>(join(r.dir, 'connections-result.json')).find(y => y.connector_slug === 'sendgrid')
    expect(x).toMatchObject({ ok: true, status: 'post_install_error', error_code: 'post_install_error' })
    expect(r.out.join('\n')).toContain('run-post-install')
  })

  test('provider_unavailable is a plain failure that does not stop the run, and is not connection_import_unavailable', async () => {
    const r = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi((b, n) => (b.connector_slug === 'slack' ? json({ error: { code: 'provider_unavailable', message: 'Slack is down.' } }, 503) : created(`conn_${n}`))))
    const res = readJson<ConnResult[]>(join(r.dir, 'connections-result.json'))
    expect(res.map(x => x.error_code ?? 'ok')).toEqual(['provider_unavailable', 'ok', 'ok', 'ok'])
    expect(r.out.join('\n')).toContain('did not answer')
    expect(r.out.join('\n')).not.toContain('cannot import connections yet')
    const bad = await run(['--accounts-file', ACCOUNTS, '--map', MAP, '--apply'], elaichi(errOnAll(502, { code: 'provider_unavailable', message: 'x' })))
    expect(readJson<ConnResult[]>(join(bad.dir, 'connections-result.json')).every(x => x.error_code === 'provider_unavailable')).toBe(true)
  })
})
