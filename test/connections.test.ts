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
  'acme-crm': {
    slug: 'acme-crm',
    auth_formats: ['api_key'],
    auth_fields: { api_key: [{ name: 'api_token', label: 'API token', required: true, secret: true }, { name: 'domain', label: 'Domain', required: true, secret: false }] },
  },
}
const ORG_OAUTH_APPS: Record<string, unknown> = { slack: { client_id: 'client_acme_slack' } }

type Post = (body: { connector_slug: string; credentials: { values: Record<string, string> } }, n: number) => Response
interface Call {
  method: string
  url: string
  body?: string
  headers: Record<string, string>
}

/** A fake Elaichi API. `post` answers POST /connection; the default creates the connection. */
function elaichi(post: Post = (b, n) => json({ id: `conn_${n}_${b.connector_slug}`, status: 'active' }, 201)) {
  const calls: Call[] = []
  let n = 0
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined, headers: (init?.headers ?? {}) as Record<string, string> })
    const path = new URL(url).pathname
    let m = /^\/connector\/([^/]+)\/oauth-app$/.exec(path)
    if (m?.[1] && method === 'GET') return ORG_OAUTH_APPS[m[1]] ? json(ORG_OAUTH_APPS[m[1]]) : json({ error: { code: 'not_found', message: 'No OAuth app' } }, 404)
    m = /^\/connector\/([^/]+)$/.exec(path)
    if (m?.[1] && method === 'GET') return CONNECTORS[m[1]] ? json(CONNECTORS[m[1]]) : json({ error: { code: 'not_found', message: 'No such connector' } }, 404)
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
    expect(plan.summary).toEqual({ importable: 2, org_oauth_app_needed: 1, needs_mapping: 1, no_connector: 1, reconnect: 2 })
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
    expect(accountsFromJson([{ data: [acc] }, { data: [acc, acc] }])).toHaveLength(3)
    expect(accountsFromJson([acc, acc])).toHaveLength(2)
    expect(() => accountsFromJson({ accounts: [] })).toThrow()
  })
  test('needs an Elaichi token, and refuses a positional argument', async () => {
    expect(await main(['connections', '--accounts-file', ACCOUNTS], {}, () => {}, elaichi().f)).toBe(1)
    expect(await main(['connections', ACCOUNTS], ENV, () => {}, elaichi().f)).toBe(1)
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
    ])
    const results = readJson<ConnResult[]>(join(out, 'connections-result.json'))
    expect(results.map(r => [r.pipedream_account_id, r.ok, r.connection_id])).toEqual([
      ['apn_slack1', true, 'conn_1_slack'],
      ['apn_sendgrid1', true, 'conn_2_sendgrid'],
      ['apn_acme1', true, 'conn_3_acme-crm'],
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
    b.connector_slug === slug ? json({ error }, status, headers) : json({ id: `conn_${n}`, status: 'active' }, 201)

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
    const { results, lines } = await applyWith(errOn('sendgrid', 400, { code: 'invalid_credentials', message: 'api_key is not valid.', details: { field: 'api_key' } }))
    expect(results.find(r => r.connector_slug === 'sendgrid')).toMatchObject({ ok: false, error_code: 'invalid_credentials', field: 'api_key' })
    expect(lines.join('\n')).toContain('(field api_key)')
  })
  test('401 stops the run: later accounts are not sent', async () => {
    const { results, api } = await applyWith(() => json({ error: { code: 'unauthorized', message: 'Bad token' } }, 401))
    expect(api.posts()).toHaveLength(1)
    expect(results.map(r => r.error_code)).toEqual(['unauthorized', 'skipped'])
  })
  test('429 waits for Retry-After once, then sends again', async () => {
    let first = true
    const post: Post = (b, n) => {
      if (first) {
        first = false
        return json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'Retry-After': '0.001' })
      }
      return json({ id: `conn_${n}`, status: 'active' }, 201)
    }
    const { results, api } = await applyWith(post)
    expect(api.posts()).toHaveLength(3)
    expect(results.every(r => r.ok)).toBe(true)
  })
  test('refuses to run --apply twice in one folder without --force', async () => {
    const { out } = await applyWith((_, n) => json({ id: `conn_${n}` }, 201))
    const api = elaichi()
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply'], ENV, () => {}, api.f)).toBe(1)
    expect(api.calls).toEqual([])
    expect(await main(['connections', '--accounts-file', ACCOUNTS, '--out', out, '--apply', '--force'], ENV, () => {}, api.f)).toBe(0)
  })
})

describe('no secret leaves memory except in POST /connection', () => {
  const filesIn = (dir: string) => readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8'))
  test('dry run, apply success and an error that echoes the secret', async () => {
    // An Elaichi error that quotes what it was sent: the scrubber must still keep it out of logs and files.
    const echo: Post = (b, n) => (b.connector_slug === 'sendgrid' ? json({ error: { code: 'invalid_credentials', message: `bad key ${b.credentials.values.api_key}`, details: { field: 'api_key' } } }, 400) : json({ id: `conn_${n}` }, 201))
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
    expect(r).toMatchObject({ ok: false, error_code: 'http_502', error: '502' })
    expect(JSON.stringify(r)).not.toContain(SENTINEL)
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
