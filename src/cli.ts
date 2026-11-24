#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { checkDefinition, findTodos } from './check.ts'
import { loadInput } from './parse.ts'
import { convertProject } from './project.ts'
import { pushDrafts, validateDrafts } from './push.ts'
import type { DraftBody } from './types.ts'
import { renderMarkdown } from './report.ts'

const HELP = `pipedream-to-elaichi: turn Pipedream workflow exports into Elaichi workflow drafts.

Usage:
  pipedream-to-elaichi <project_export.zip | export folder | workflow.json> [options]
  pipedream-to-elaichi check <drafts folder | draft.elaichi.json> [--json]
  pipedream-to-elaichi validate <drafts folder | draft.elaichi.json> [--json] [--api-url <url>]
  pipedream-to-elaichi push <drafts folder | draft.elaichi.json> [--api-url <url>]

Commands:
  (none)     Convert an export: write drafts, report.md and report.json.
  check      Check drafts on this computer: shape problems and import TODOs still open.
             Exits 0 when only the review gate (import_review) is left.
  validate   Check drafts with Elaichi's own validator (POST /automation/validate). Saves nothing.
             Needs ELAICHI_API_TOKEN.
  push       Create each draft in Elaichi (POST /automation). Never publishes or turns anything on.
             Needs ELAICHI_API_TOKEN.

Options:
  --out <dir>              Where to write drafts and the report (default: ./elaichi-drafts)
  --toolbox <slug>=<tbx_>  Use this stored toolbox for an Elaichi connector, e.g. --toolbox slack=tbx_abc (repeatable)
  --push                   Also create each draft in Elaichi with POST /automation.
                           Needs ELAICHI_API_TOKEN. Drafts are never published or turned on.
  --api-url <url>          Elaichi API base URL (default: https://api.elaichi.ai)
  --json                   check / validate: print the result as JSON
  -h, --help               Show this help

Writes one <workflow>.elaichi.json per workflow ({ name, description, definition }, the body of
POST /automation), report.md, report.json, and migration-plan.json: every open item with its reason,
the original code and the Elaichi limit it hits, for an AI coding agent to work through.`

export interface CliArgs {
  command?: 'check' | 'validate' | 'push'
  json: boolean
  input?: string
  out: string
  toolboxes: Record<string, string>
  push: boolean
  apiUrl?: string
  help: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: 'elaichi-drafts', toolboxes: {}, push: false, help: false, json: false }
  if (argv[0] === 'check' || argv[0] === 'validate' || argv[0] === 'push') {
    args.command = argv[0]
    argv = argv.slice(1)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '-h' || a === '--help') args.help = true
    else if (a === '--out') args.out = next()
    else if (a === '--push') args.push = true
    else if (a === '--json') args.json = true
    else if (a === '--api-url') args.apiUrl = next()
    else if (a === '--toolbox') {
      const v = next()
      const m = /^([a-z0-9_-]+)=(tbx_[A-Za-z0-9_-]+)$/i.exec(v)
      if (!m?.[1] || !m[2]) throw new Error(`--toolbox expects <slug>=tbx_…, got "${v}"`)
      args.toolboxes[m[1]] = m[2]
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
    else if (args.input === undefined) args.input = a
    else throw new Error(`unexpected argument ${a}`)
  }
  return args
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, log = console.log): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    log(`Error: ${(e as Error).message}\n\n${HELP}`)
    return 1
  }
  if (args.help || !args.input) {
    log(HELP)
    return args.help ? 0 : 1
  }
  const token = env.ELAICHI_API_TOKEN
  if (args.command) return runCommand(args.command, args, token, log)
  if (args.push && !token) {
    log('Error: --push needs ELAICHI_API_TOKEN (create one in Elaichi under Settings → API tokens).')
    return 1
  }

  let loaded
  try {
    loaded = loadInput(resolve(args.input))
  } catch (e) {
    log(`Error: cannot read ${args.input}: ${(e as Error).message}`)
    return 1
  }
  const { drafts, report, plan } = convertProject(loaded, args.input, args.toolboxes)
  if (drafts.length === 0) {
    log(`No workflows converted from ${args.input}.`)
    for (const n of report.not_converted) log(`- ${n.name}: ${n.reason}`)
    return 1
  }

  mkdirSync(args.out, { recursive: true })
  for (const d of drafts) writeFileSync(join(args.out, d.file), `${JSON.stringify(d.body, null, 2)}\n`)
  writeFileSync(join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(args.out, 'report.md'), renderMarkdown(report))
  writeFileSync(join(args.out, 'migration-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  for (const w of report.workflows) {
    log(`${w.name}: mapped ${w.summary.mapped}, needs work ${w.summary.needs_work}, no match ${w.summary.no_match} → ${join(args.out, w.output_file)}`)
    for (const i of w.shape_issues) log(`  shape problem: ${i}`)
  }
  for (const n of report.not_converted) log(`Not converted: ${n.name}: ${n.reason}`)
  log(`Report: ${join(args.out, 'report.md')}`)
  const open = plan.workflows.reduce((n, w) => n + w.items.length, 0)
  log(`Work list for an AI coding agent: ${join(args.out, 'migration-plan.json')} (${open} item${open === 1 ? '' : 's'})`)

  if (args.push && token) {
    const results = await pushDrafts(drafts, { token, apiUrl: args.apiUrl })
    writeFileSync(join(args.out, 'push-result.json'), `${JSON.stringify(results, null, 2)}\n`)
    for (const r of results) log(r.ok ? `Created draft ${r.id} from ${r.file} (${r.errors} errors, ${r.issues} issues to fix before publishing)` : `Failed ${r.file}: ${r.error}`)
    log('Drafts are not published or turned on. Open each in Elaichi, fix the TODOs, validate, test-run, then publish.')
    if (results.some(r => !r.ok)) return 2
  }
  return 0
}

/** Reads `*.elaichi.json` drafts from a folder, or one draft file. */
export function loadDrafts(path: string): { file: string; body: DraftBody }[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter(f => f.endsWith('.elaichi.json')).sort().map(f => join(path, f))
    : [path]
  return files.map(f => {
    const body = JSON.parse(readFileSync(f, 'utf8')) as DraftBody
    if (!body || typeof body !== 'object' || typeof body.definition !== 'object') throw new Error(`${f} is not a draft ({ name, description, definition })`)
    return { file: basename(f), body }
  })
}

async function runCommand(command: 'check' | 'validate' | 'push', args: CliArgs, token: string | undefined, log: (s: string) => void): Promise<number> {
  if (!args.input) {
    log(`Error: ${command} needs a drafts folder or a .elaichi.json file.\n\n${HELP}`)
    return 1
  }
  if (command !== 'check' && !token) {
    log(`Error: ${command} needs ELAICHI_API_TOKEN (create one in Elaichi under Settings → API tokens).`)
    return 1
  }
  let drafts
  try {
    drafts = loadDrafts(resolve(args.input))
  } catch (e) {
    log(`Error: cannot read ${args.input}: ${(e as Error).message}`)
    return 1
  }
  if (drafts.length === 0) {
    log(`No .elaichi.json drafts in ${args.input}.`)
    return 1
  }

  if (command === 'check') {
    const results = drafts.map(d => ({ file: d.file, shape_issues: checkDefinition(d.body.definition, { strict: false }), ...findTodos(d.body.definition) }))
    const open = results.filter(r => r.shape_issues.length + r.todos.length > 0)
    if (args.json) log(JSON.stringify({ ok: open.length === 0, drafts: results }, null, 2))
    else {
      for (const r of results) {
        log(`${r.file}: ${r.shape_issues.length + r.todos.length === 0 ? 'no open TODOs' : `${r.todos.length} open TODO${r.todos.length === 1 ? '' : 's'}, ${r.shape_issues.length} shape problem${r.shape_issues.length === 1 ? '' : 's'}`}`)
        for (const i of r.shape_issues) log(`  shape: ${i}`)
        for (const t of r.todos) log(`  todo: ${t}`)
        if (r.reviewGate) log('  review gate: import_review is still the first step. Delete it after a person has reviewed the draft.')
      }
      if (open.length === 0)
        log(
          results.some(r => r.reviewGate)
            ? 'No open TODOs. Run validate next (it also checks toolboxes, tools and JSONata). The review gate is still open: a person must review each draft before you delete import_review.'
            : 'No open TODOs. Run validate next: it also checks toolboxes, tools and JSONata.',
        )
    }
    return open.length === 0 ? 0 : 1
  }

  if (command === 'validate') {
    const results = await validateDrafts(drafts, { token: token as string, apiUrl: args.apiUrl })
    if (args.json) log(JSON.stringify({ ok: results.every(r => r.ok), drafts: results }, null, 2))
    else
      for (const r of results) {
        if (r.error) log(`${r.file}: request failed: ${r.error}`)
        else log(`${r.file}: ${r.ok ? 'valid' : 'not valid'}${r.issues?.length ? `, ${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}` : ''}`)
        for (const i of r.issues ?? []) log(`  ${i.severity ?? 'issue'} ${i.code ?? ''} ${typeof i.path === 'string' ? i.path : i.path ? JSON.stringify(i.path) : ''}: ${i.message ?? ''}`.replace(/\s+/g, ' ').trimEnd())
      }
    return results.every(r => r.ok) ? 0 : 1
  }

  const results = await pushDrafts(drafts, { token: token as string, apiUrl: args.apiUrl })
  for (const r of results) log(r.ok ? `Created draft ${r.id} from ${r.file} (${r.errors} errors, ${r.issues} issues to fix before publishing)` : `Failed ${r.file}: ${r.error}`)
  log('Drafts are not published or turned on. Open each in Elaichi, test-run it, then publish and turn it on.')
  return results.some(r => !r.ok) ? 2 : 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
