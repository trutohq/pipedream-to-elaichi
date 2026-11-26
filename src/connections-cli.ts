import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CliArgs } from './cli.ts'
import {
  accountsFromJson,
  applyConnections,
  CONN_STATUSES,
  type ConnMap,
  type ConnResult,
  type ConnStatus,
  ElaichiError,
  errorHelp,
  fetchPipedreamAccounts,
  type PdAccount,
  planConnections,
  scrubber,
  secretsOf,
  SENDABLE,
} from './connections.ts'

const LABEL: Record<ConnStatus, string> = {
  importable: 'importable',
  reconnect: 'reconnect',
  needs_mapping: 'needs mapping',
  org_oauth_app_needed: 'org OAuth app needed',
  org_oauth_app_unknown: 'org OAuth app unknown',
  no_connector: 'no connector',
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * `connections`: dry run by default, `--apply` to create. Every line it prints and every file it writes goes through
 * a scrubber that blanks credential values, on top of the rule that values are never put in a message.
 */
export async function runConnections(args: CliArgs, env: Record<string, string | undefined>, rawLog: (s: string) => void, fetchFn: typeof fetch): Promise<number> {
  const token = env.ELAICHI_API_TOKEN
  if (!token) {
    rawLog('Error: connections needs ELAICHI_API_TOKEN (create one in Elaichi under Settings → API tokens).')
    return 1
  }
  const out = args.outSet ? args.out : 'elaichi-connections'
  const resultFile = join(out, 'connections-result.json')
  // Results of an earlier --apply in this folder: accounts it created are skipped, so a re-run never creates them twice.
  let earlier: ConnResult[] = []
  if (args.apply && existsSync(resultFile) && !args.force) {
    try {
      const j = JSON.parse(readFileSync(resultFile, 'utf8')) as unknown
      if (!Array.isArray(j)) throw new Error('not a list')
      earlier = j as ConnResult[]
    } catch {
      rawLog(`Error: cannot read ${resultFile}. Fix or move it, or add --force to ignore it (that can create connections twice).`)
      return 1
    }
  }
  const envScrub = scrubber([token, env.PIPEDREAM_CLIENT_SECRET, env.PIPEDREAM_API_KEY].filter((s): s is string => !!s))

  let map: ConnMap = {}
  if (args.map) {
    try {
      const j = JSON.parse(readFileSync(resolve(args.map), 'utf8')) as unknown
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('expected a JSON object')
      map = j as ConnMap
    } catch (e) {
      rawLog(`Error: cannot read --map ${args.map}: ${(e as Error).message}`)
      return 1
    }
  }

  let accounts: PdAccount[]
  let source: string
  if (args.accountsFile) {
    source = args.accountsFile
    let text: string
    try {
      text = readFileSync(resolve(args.accountsFile), 'utf8')
    } catch (e) {
      rawLog(`Error: cannot read ${args.accountsFile}: ${(e as Error).message}`)
      return 1
    }
    try {
      accounts = accountsFromJson(JSON.parse(text))
    } catch (e) {
      // A JSON parse error can quote part of the file, which may be a secret: say only that it is not valid.
      rawLog(`Error: ${args.accountsFile} is not a Pipedream list-accounts answer${e instanceof SyntaxError ? ' (not valid JSON)' : `: ${(e as Error).message}`}.`)
      return 1
    }
  } else {
    source = 'Pipedream API (GET /v1/accounts?include_credentials=true)'
    try {
      accounts = await fetchPipedreamAccounts(env, fetchFn)
    } catch (e) {
      rawLog(envScrub(`Error: cannot list Pipedream accounts: ${(e as Error).message}`))
      return 1
    }
  }

  const scrub = scrubber([...secretsOf(accounts), token, ...[env.PIPEDREAM_CLIENT_SECRET, env.PIPEDREAM_API_KEY].filter((s): s is string => !!s)])
  const log = (s: string) => rawLog(scrub(s))
  const write = (file: string, data: unknown) => writeFileSync(join(out, file), scrub(`${JSON.stringify(data, null, 2)}\n`))

  if (accounts.length === 0) {
    log(`No connected accounts in ${source}.`)
    return 1
  }
  const withCreds = accounts.filter(a => a.credentials && typeof a.credentials === 'object' && Object.keys(a.credentials).length > 0).length
  if (args.accountsFile && withCreds > 0)
    log(`Warning: ${args.accountsFile} holds live credentials for ${withCreds} account${withCreds === 1 ? '' : 's'}. Keep it private, never commit or share it, and delete it when you are done.`)

  const deps = { token, apiUrl: args.apiUrl, fetch: fetchFn }
  let planned
  try {
    planned = await planConnections(accounts, map, deps, source)
  } catch (e) {
    log(`Error: ${(e as Error).message}`)
    return e instanceof ElaichiError ? 1 : 2
  }
  const { plan, classified } = planned
  mkdirSync(out, { recursive: true })
  write('connections-plan.json', plan)

  if (args.json && !args.apply) log(JSON.stringify(plan, null, 2))
  else {
    log('| Pipedream app | Account | Elaichi connector | Status | Why |')
    log('|---|---|---|---|---|')
    for (const i of plan.accounts)
      log(`| ${cell(i.pipedream_app)} | ${cell(i.pipedream_account_name ?? i.pipedream_account_id)} | ${cell(i.connector_slug ?? '—')} | ${LABEL[i.status]} | ${cell(i.reasons.join(' ') || '—')} |`)
    log(CONN_STATUSES.map(s => `${LABEL[s]} ${plan.summary[s]}`).join(', '))
    const reconnect = plan.accounts.filter(i => !SENDABLE.includes(i.status))
    if (reconnect.length > 0) log(`Connect again in Elaichi (or fix the mapping first): ${[...new Set(reconnect.map(i => i.connector_slug ?? i.pipedream_app))].join(', ')}.`)
    log(`Plan (no secret values): ${join(out, 'connections-plan.json')}`)
  }

  if (!args.apply) {
    const n = plan.summary.importable + plan.summary.org_oauth_app_unknown
    if (!args.json) log(n > 0 ? `Dry run: nothing was created. Add --apply to send the ${n} importable connection${n === 1 ? '' : 's'} to Elaichi.` : 'Dry run: nothing was created, and nothing is importable yet.')
    return 0
  }

  const created = new Set(earlier.filter(r => r.ok).map(r => r.pipedream_account_id))
  const merged = new Map(earlier.map(r => [r.pipedream_account_id, r]))
  if (created.size > 0) log(`Skipping ${created.size} account${created.size === 1 ? '' : 's'} an earlier --apply created (${resultFile}).`)
  const fresh = await applyConnections(classified, deps, {
    skip: created,
    onResult: r => {
      merged.set(r.pipedream_account_id, r)
      write('connections-result.json', [...merged.values()])
    },
  })
  const results = [...merged.values()]
  write('connections-result.json', results)
  if (args.json) log(JSON.stringify({ ok: results.every(r => r.ok), results }, null, 2))
  else {
    for (const r of fresh)
      log(r.ok ? `Created connection ${r.connection_id ?? '(no id returned)'} for ${r.pipedream_app} (${r.pipedream_account_id}).` : `Failed ${r.pipedream_app} (${r.pipedream_account_id}): ${r.error_code ?? ''}${r.field ? ` (field ${r.field})` : ''} ${r.error ?? ''} ${errorHelp(r.error_code)}`.replace(/\s+/g, ' ').trim())
    log(`Result: ${resultFile}`)
  }
  return results.some(r => !r.ok) ? 2 : 0
}
