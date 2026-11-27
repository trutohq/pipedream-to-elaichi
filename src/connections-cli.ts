import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CliArgs } from './cli.ts'
import {
  accountsFromJson,
  applyConnections,
  CONN_STATUSES,
  dedupeAccounts,
  type ConnMap,
  type ConnResult,
  type ConnStatus,
  ElaichiError,
  errorHelp,
  fetchPipedreamAccounts,
  type PdAccount,
  planConnections,
  scrubber,
  scrubDeep,
  secretsOf,
  SENDABLE,
  UNKNOWN_OUTCOME,
} from './connections.ts'

const LABEL: Record<ConnStatus, string> = {
  importable: 'importable',
  reconnect: 'reconnect',
  needs_mapping: 'needs mapping',
  org_oauth_app_needed: 'org OAuth app needed',
  org_oauth_app_unknown: 'org OAuth app unknown',
  no_connector: 'no connector',
  restricted: 'restricted',
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * `connections`: dry run by default, `--apply` to create. Every line it prints and every file it writes goes through
 * a scrubber that blanks credential values, on top of the rule that values are never put in a message.
 * With --json, `stdout` gets valid JSON only: every other line goes to `errLog` (stderr).
 */
export async function runConnections(
  args: CliArgs,
  env: Record<string, string | undefined>,
  stdout: (s: string) => void,
  fetchFn: typeof fetch,
  errLog: (s: string) => void = console.error,
): Promise<number> {
  const rawLog = args.json ? errLog : stdout
  const token = env.ELAICHI_API_TOKEN
  if (!token) {
    rawLog('Error: connections needs ELAICHI_API_TOKEN (create one in Elaichi under Settings → API tokens).')
    return 1
  }
  const out = args.outSet ? args.out : 'elaichi-connections'
  const resultFile = join(out, 'connections-result.json')
  // Results of an earlier --apply in this folder: accounts it created are skipped, so a re-run never creates them twice.
  let earlier: ConnResult[] = []
  let backup: string | undefined
  if (args.apply && existsSync(resultFile) && args.force) {
    // --force starts over, but never loses the record of what an earlier run created.
    backup = join(out, `connections-result.${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    renameSync(resultFile, backup)
  } else if (args.apply && existsSync(resultFile)) {
    try {
      const j = JSON.parse(readFileSync(resultFile, 'utf8')) as unknown
      if (!Array.isArray(j)) throw new Error('not a list')
      earlier = j as ConnResult[]
    } catch {
      rawLog(`Error: cannot read ${resultFile}. Fix or move it, or add --force to ignore it (that can create connections twice).`)
      return 1
    }
  }
  const pdSecrets = [env.PIPEDREAM_CLIENT_SECRET, env.PIPEDREAM_API_KEY].filter((s): s is string => !!s)
  const envScrub = scrubber([token, ...pdSecrets])

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
      accounts = dedupeAccounts(await fetchPipedreamAccounts(env, fetchFn, { warn: errLog }))
    } catch (e) {
      rawLog(envScrub(`Error: cannot list Pipedream accounts: ${(e as Error).message}`))
      return 1
    }
  }

  const scrub = scrubber([...secretsOf(accounts), token, ...pdSecrets])
  const log = (s: string) => rawLog(scrub(s))
  // Scrub the string values inside the object, then stringify: a regex over the JSON text could damage `"ok": false` or an id.
  const clean = scrubDeep(scrub)
  const json = (data: unknown) => `${JSON.stringify(clean(data), null, 2)}\n`
  const write = (file: string, data: unknown) => {
    // Temp file, then rename: a crash never leaves a half-written result file.
    const tmp = join(out, `${file}.tmp`)
    writeFileSync(tmp, json(data))
    renameSync(tmp, join(out, file))
  }

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

  if (args.json && !args.apply) stdout(json(plan).trimEnd())
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

  if (backup) log(`--force: moved the earlier result to ${backup}.`)
  const created = new Set(earlier.filter(r => r.ok).map(r => r.pipedream_account_id))
  const unknown = earlier.filter(r => UNKNOWN_OUTCOME.includes(r.error_code ?? ''))
  const merged = new Map(earlier.map(r => [r.pipedream_account_id, r]))
  if (created.size > 0) log(`Skipping ${created.size} account${created.size === 1 ? '' : 's'} an earlier --apply created (${resultFile}).`)
  const skip = new Set(created)
  for (const r of unknown) {
    if (args.retryUnknown) continue
    skip.add(r.pipedream_account_id)
    log(`Not sent again: ${r.pipedream_app} (${r.pipedream_account_id}). An earlier --apply got no clear answer, so it may already exist. Check Elaichi for a ${r.connector_slug ?? r.pipedream_app} connection named "${r.connection_name ?? r.pipedream_account_id}" first. If there is none, run again with --retry-unknown.`)
  }
  const record = (r: ConnResult) => {
    merged.set(r.pipedream_account_id, r)
    write('connections-result.json', [...merged.values()])
  }
  const fresh = await applyConnections(classified, deps, {
    skip,
    onPending: record,
    onResult: record,
  })
  const results = [...merged.values()]
  write('connections-result.json', results)
  const needsRepair = (r: ConnResult) => r.ok && r.status === 'post_install_error'
  if (args.json) stdout(json({ ok: results.every(r => r.ok && !needsRepair(r)), results }).trimEnd())
  else {
    for (const r of fresh)
      log(needsRepair(r) ? `Created connection ${r.connection_id ?? '(no id returned)'} for ${r.pipedream_app} (${r.pipedream_account_id}), but it needs repair. ${errorHelp('post_install_error')}` : r.ok ? `Created connection ${r.connection_id ?? '(no id returned)'} for ${r.pipedream_app} (${r.pipedream_account_id})${r.credential_tested === false ? ', credentials not tested by Elaichi' : ''}.` : `Failed ${r.pipedream_app} (${r.pipedream_account_id}): ${r.error_code ?? ''}${r.field ? ` (field ${r.field})` : ''} ${r.error ?? ''} ${errorHelp(r.error_code)}`.replace(/\s+/g, ' ').trim())
    const older = results.filter(r => needsRepair(r) && !fresh.includes(r))
    if (older.length > 0) log(`Needs repair (created earlier, post-install failed): ${older.map(r => r.connection_id ?? r.pipedream_account_id).join(', ')}. ${errorHelp('post_install_error')}`)
    log(`Result: ${resultFile}`)
  }
  // Exit 2 for a failure, or a post_install_error this run produced. Older ones are listed above but do not fail a re-run.
  return results.some(r => !r.ok) || fresh.some(needsRepair) ? 2 : 0
}
