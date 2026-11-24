#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadInput } from './parse.ts'
import { convertProject } from './project.ts'
import { pushDrafts } from './push.ts'
import { renderMarkdown } from './report.ts'

const HELP = `pipedream-to-elaichi: turn Pipedream workflow exports into Elaichi workflow drafts.

Usage:
  pipedream-to-elaichi <project_export.zip | export folder | workflow.json> [options]

Options:
  --out <dir>              Where to write drafts and the report (default: ./elaichi-drafts)
  --toolbox <slug>=<tbx_>  Use this stored toolbox for an Elaichi connector, e.g. --toolbox slack=tbx_abc (repeatable)
  --push                   Also create each draft in Elaichi with POST /automation.
                           Needs ELAICHI_API_TOKEN. Drafts are never published or turned on.
  --api-url <url>          Elaichi API base URL (default: https://api.elaichi.ai)
  -h, --help               Show this help

Writes one <workflow>.elaichi.json per workflow ({ name, description, definition }, the body of
POST /automation), report.md and report.json.`

export interface CliArgs {
  input?: string
  out: string
  toolboxes: Record<string, string>
  push: boolean
  apiUrl?: string
  help: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: 'elaichi-drafts', toolboxes: {}, push: false, help: false }
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
  const { drafts, report } = convertProject(loaded, args.input, args.toolboxes)
  if (drafts.length === 0) {
    log(`No workflows converted from ${args.input}.`)
    for (const n of report.not_converted) log(`- ${n.name}: ${n.reason}`)
    return 1
  }

  mkdirSync(args.out, { recursive: true })
  for (const d of drafts) writeFileSync(join(args.out, d.file), `${JSON.stringify(d.body, null, 2)}\n`)
  writeFileSync(join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(args.out, 'report.md'), renderMarkdown(report))

  for (const w of report.workflows) {
    log(`${w.name}: mapped ${w.summary.mapped}, needs work ${w.summary.needs_work}, no match ${w.summary.no_match} → ${join(args.out, w.output_file)}`)
    for (const i of w.shape_issues) log(`  shape problem: ${i}`)
  }
  for (const n of report.not_converted) log(`Not converted: ${n.name}: ${n.reason}`)
  log(`Report: ${join(args.out, 'report.md')}`)

  if (args.push && token) {
    const results = await pushDrafts(drafts, { token, apiUrl: args.apiUrl })
    writeFileSync(join(args.out, 'push-result.json'), `${JSON.stringify(results, null, 2)}\n`)
    for (const r of results) log(r.ok ? `Created draft ${r.id} from ${r.file} (${r.errors} errors, ${r.issues} issues to fix before publishing)` : `Failed ${r.file}: ${r.error}`)
    log('Drafts are not published or turned on. Open each in Elaichi, fix the TODOs, validate, test-run, then publish.')
    if (results.some(r => !r.ok)) return 2
  }
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
