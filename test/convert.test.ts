import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { checkDefinition } from '../src/check.ts'
import { main } from '../src/cli.ts'
import { literalNumber } from '../src/code.ts'
import { convertWorkflow } from '../src/convert.ts'
import { loadInput, parseWorkflow } from '../src/parse.ts'
import { convertProject } from '../src/project.ts'
import { pushDrafts } from '../src/push.ts'
import { renderMarkdown } from '../src/report.ts'
import { pathToJsonata, valueToJsonata, type RefContext } from '../src/templates.ts'
import type { Step } from '../src/types.ts'

const FIX = join(import.meta.dir, 'fixtures')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as unknown
const convert = (name: string, toolboxes?: Record<string, string>) => convertWorkflow(parseWorkflow(fixture(name), name), { toolboxes })
const flat = (steps: Step[]): Step[] => steps.flatMap(s => [s, ...(Array.isArray(s.branches) ? (s.branches as { steps: Step[] }[]).flatMap(b => flat(b.steps)) : [])])
const step = (steps: Step[], key: string) => {
  const s = flat(steps).find(x => x.key === key)
  if (!s) throw new Error(`no step ${key}`)
  return s
}
const ALL = ['schedule-slack.json', 'http-respond.json', 'delay-suspend.json', 'polyglot.json', 'data-store.json', 'apps.json', 'github-sync-style.json']

describe('every fixture', () => {
  for (const name of ALL) {
    test(`${name}: draft passes the local shape check`, () => {
      const { draft } = convert(name)
      expect(checkDefinition(draft.definition)).toEqual([])
    })
    test(`${name}: every Pipedream step is in the report exactly once, and every report row points at real steps`, () => {
      const wf = parseWorkflow(fixture(name), name)
      const { draft, report } = convertWorkflow(wf)
      const input = [...wf.steps, ...wf.branches.flatMap(b => b.steps)].map(s => s.namespace).sort()
      const rows = report.steps.filter(s => s.source !== 'deployments') // the control-flow row is extra
      expect(rows.map(s => s.namespace).sort()).toEqual(input)
      const keys = new Set(flat(draft.definition.steps).map(s => s.key))
      for (const r of rows) {
        expect(r.elaichi_keys.length).toBeGreaterThan(0)
        for (const k of r.elaichi_keys) expect(keys.has(k)).toBe(true)
      }
      expect(report.triggers.length).toBe(wf.triggers.length)
    })
    test(`${name}: nothing is "mapped" while a TODO is open in it`, () => {
      const { draft, report } = convert(name)
      const byKey = new Map(flat(draft.definition.steps).map(s => [s.key, s]))
      for (const r of report.steps) {
        const todo = r.elaichi_keys.some(k => {
          const s = byKey.get(k)
          return s?.type === 'check' || String(s?.toolbox_id ?? '').startsWith('tbx_REPLACE_') || String(s?.name ?? '').startsWith('TODO')
        })
        if (todo) expect(r.status).not.toBe('mapped')
      }
      const open = report.summary.needs_work + report.summary.no_match
      expect(draft.definition.steps[0]?.key === 'import_review').toBe(open > 0 || report.secrets.length > 0)
    })
  }
})

describe('triggers', () => {
  test('timer cron keeps its time zone; a manual trigger is added for test runs', () => {
    const { draft, report } = convert('schedule-slack.json')
    expect(draft.definition.triggers).toEqual([
      { key: 'schedule', type: 'cron', cron: '0 9 * * 1-5', timezone: 'Europe/London' },
      { key: 'manual', type: 'manual' },
    ])
    expect(report.triggers[0]?.status).toBe('mapped')
  })
  test('a cron under 5 minutes is raised to every 5 minutes and flagged', () => {
    const { draft, report } = convert('data-store.json')
    expect(draft.definition.triggers[0]).toMatchObject({ type: 'cron', cron: '*/5 * * * *', timezone: 'UTC' })
    expect(report.triggers[0]?.status).toBe('needs_work')
  })
  test('an hourly interval becomes an hourly cron; no time zone needed', () => {
    const { draft, report } = convert('delay-suspend.json')
    expect(draft.definition.triggers[0]).toMatchObject({ type: 'cron', cron: '0 * * * *' })
    expect(report.triggers[0]?.status).toBe('mapped')
  })
  test('HTTP becomes a token webhook, POST only, flagged for the new URL and the GET it took', () => {
    const { draft, report } = convert('http-respond.json')
    expect(draft.definition.triggers[0]).toEqual({ key: 'webhook', type: 'webhook', auth: { scheme: 'token' }, methods: ['POST'] })
    expect(report.triggers[0]?.status).toBe('needs_work')
    expect(report.triggers[0]?.notes.join(' ')).toContain('GET')
  })
  test('source and email triggers have no match and leave a manual trigger', () => {
    const a = convert('polyglot.json')
    expect(a.draft.definition.triggers).toEqual([{ key: 'manual', type: 'manual' }])
    expect(a.report.triggers[0]).toMatchObject({ status: 'no_match', source: 'app event source github-new-issue-with-status' })
    const b = convert('apps.json')
    expect(b.report.triggers[1]).toMatchObject({ status: 'no_match', source: 'email trigger' })
    expect(b.report.triggers[1]?.notes[0]).toContain('no email trigger')
  })
  test('GitHub Sync trigger ids are read by prefix (ti_ = timer)', () => {
    const { report } = convert('github-sync-style.json')
    expect(report.triggers[0]?.source).toBe('timer')
    expect(report.triggers[0]?.status).toBe('needs_work') // no schedule in the file
  })
})

describe('app actions', () => {
  test('Slack send message → call_tool with mapped args and a placeholder toolbox (needs work)', () => {
    const { draft, report } = convert('schedule-slack.json')
    const s = step(draft.definition.steps, 'send_message')
    expect(s).toMatchObject({ type: 'call_tool', tool: 'create_a_slack_chat', toolbox_id: 'tbx_REPLACE_slack', args: '{"channel": "C0123456789", "text": steps.build_text.text}' })
    expect(draft.definition.toolboxes).toEqual(['tbx_REPLACE_slack'])
    expect(report.steps[1]?.status).toBe('needs_work')
    expect(report.reconnect).toEqual(['slack'])
  })
  test('with --toolbox given, the same step is mapped', () => {
    const { draft, report } = convert('schedule-slack.json', { slack: 'tbx_real' })
    expect(step(draft.definition.steps, 'send_message').toolbox_id).toBe('tbx_real')
    expect(report.steps.map(s => s.status)).toEqual(['mapped', 'mapped'])
    expect(draft.definition.steps[0]?.key).toBe('build_text') // no review gate: nothing left to do
  })
  test('a known tool without an args mapping needs its args written; its props are listed, never passed through', () => {
    const { draft, report } = convert('apps.json', { notion: 'tbx_n' })
    const s = step(draft.definition.steps, 'page')
    expect(s.args).toBeUndefined()
    const r = report.steps.find(x => x.namespace === 'page')
    expect(r?.status).toBe('needs_work')
    expect(r?.notes.join(' ')).toContain('Write the tool arguments')
  })
  test('unverified mappings stay needs work even with a toolbox', () => {
    const { report } = convert('apps.json', { 'github-mcp': 'tbx_g' })
    expect(report.steps.find(x => x.namespace === 'github_issue')?.status).toBe('needs_work')
  })
  test('no Elaichi connector vs not in the table are told apart', () => {
    const { report } = convert('apps.json')
    const card = report.steps.find(x => x.namespace === 'card')
    const crm = report.steps.find(x => x.namespace === 'crm')
    expect(card?.status).toBe('no_match')
    expect(card?.notes[0]).toContain('no Trello connector')
    expect(crm?.status).toBe('no_match')
    expect(crm?.notes[0]).toContain("not in this importer's table")
    expect(crm?.notes[0]).toContain('may still have a connector')
  })
  test('private components, HTTP requests and unrecognized steps hold their place as failing TODO checks', () => {
    const { draft } = convert('apps.json')
    for (const k of ['private_thing', 'get_url', 'if_else_1', 'card', 'crm']) expect(step(draft.definition.steps, k)).toMatchObject({ type: 'check', assert: 'false', severity: 'fail' })
  })
  test('control-flow branches come over switched off, inside one branch step', () => {
    const { draft, report } = convert('apps.json')
    const b = step(draft.definition.steps, 'control_flow')
    expect(b.type).toBe('branch')
    expect((b.branches as { when: string; steps: Step[] }[])[0]).toMatchObject({ when: 'false' })
    expect(report.steps.find(s => s.namespace === 'side_message')?.branch).toBe('dep_abc')
  })
  test('http-return-http-response is flagged: Elaichi answers 202 itself', () => {
    const { draft, report } = convert('http-respond.json')
    expect(step(draft.definition.steps, 'reply').type).toBe('check')
    expect(report.steps.find(s => s.namespace === 'reply')?.notes.join(' ')).toContain('202')
  })
})

describe('code steps', () => {
  test('a Node.js step is wrapped to run unchanged, with props and earlier results in input', async () => {
    const { draft, report } = convert('schedule-slack.json', { slack: 'tbx_x' })
    const s = step(draft.definition.steps, 'build_text')
    expect(s).toMatchObject({ type: 'code', language: 'javascript', input: '{"steps": {}, "props": {"greeting": "Good morning"}}' })
    expect(report.steps[0]?.status).toBe('mapped')
    // Run the wrapped source the way Elaichi does: as the body of `async function (input)`.
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (input: unknown) => Promise<unknown>
    const run = new AsyncFunction('input', String(s.source))
    expect(await run({ steps: {}, props: { greeting: 'Hi' } })).toEqual({ text: 'Hi, team. Post your update in this thread.' })
  })
  test('imports, network, process.env and $.respond are flagged; imports are commented out', async () => {
    const { draft, report } = convert('http-respond.json')
    const s = step(draft.definition.steps, 'enrich')
    expect(String(s.source)).toContain('// TODO (no npm packages in Elaichi): import axios')
    expect(s.input).toBe('{"steps": {"trigger": {"event": trigger.payload}}, "props": {}}')
    const notes = report.steps[0]?.notes.join(' ') ?? ''
    for (const w of ['npm packages (axios)', 'network calls', 'process.env', '$.respond', 'redacted secret prop api_key']) expect(notes).toContain(w)
    expect(report.steps[0]?.status).toBe('needs_work')
    expect(report.secrets).toEqual(['enrich: api_key'])
  })
  test('$.flow.delay → wait after the step; over 1 hour is capped and flagged', () => {
    const { draft, report } = convert('delay-suspend.json')
    expect(step(draft.definition.steps, 'wait_a_bit_delay')).toMatchObject({ type: 'wait', seconds: 900 })
    expect(report.steps[0]?.status).toBe('mapped')
    expect(step(draft.definition.steps, 'long_pause_delay')).toMatchObject({ type: 'wait', seconds: 3600 })
    const long = report.steps.find(s => s.namespace === 'long_pause')
    expect(long?.status).toBe('needs_work')
    expect(long?.notes.join(' ')).toContain('at most 1 hour')
  })
  test('$.flow.suspend → approve with the timeout; resume_url use is flagged', () => {
    const { draft, report } = convert('delay-suspend.json')
    expect(step(draft.definition.steps, 'ask_manager_approval')).toMatchObject({ type: 'approve', approvers: { include_owner: true }, expires_after_seconds: 86400, on_reject: 'stop', on_expire: 'fail' })
    expect(report.steps.find(s => s.namespace === 'ask_manager')?.notes.join(' ')).toContain('resume_url')
  })
  test('$.flow.exit → the step returns a marker and a filter stops the steps after it', async () => {
    const { draft } = convert('delay-suspend.json')
    const filter = step(draft.definition.steps, 'long_pause_exit')
    expect(filter).toMatchObject({ type: 'filter', condition: '$not(steps.long_pause.__pd_flow_exit = true)' })
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (input: unknown) => Promise<unknown>
    const run = new AsyncFunction('input', String(step(draft.definition.steps, 'long_pause').source))
    expect(await run({ steps: { wait_a_bit: { $return_value: { queued: false } } } })).toEqual({ __pd_flow_exit: true, reason: 'nothing queued' })
  })
  test('Python, Go and Bash become JavaScript code steps that keep the original and fail until ported', async () => {
    const { draft, report } = convert('polyglot.json')
    for (const [k, lang] of [['score', 'Python'], ['go_step', 'Go'], ['bash_step', 'Bash']] as const) {
      const s = step(draft.definition.steps, k)
      expect(s.type).toBe('code')
      expect(String(s.source)).toContain(`was ${lang}`)
      expect(report.steps.find(r => r.namespace === k)?.status).toBe('needs_work')
    }
    const src = String(step(draft.definition.steps, 'score').source)
    expect(src).toContain('ends *\\/ early') // a */ in the original cannot close the comment
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (input: unknown) => Promise<unknown>
    await expect(new AsyncFunction('input', src)({})).rejects.toThrow('TODO: port the Python step "score"')
  })
  test('a disabled step is kept with run_if "false"', () => {
    const { draft, report } = convert('polyglot.json')
    expect(step(draft.definition.steps, 'old_debug').run_if).toBe('false')
    expect(report.steps.find(s => s.namespace === 'old_debug')?.notes.join(' ')).toContain('Disabled')
  })
  test('code in a separate GitHub Sync file is a TODO', () => {
    const { report } = convert('github-sync-style.json')
    expect(report.steps.find(s => s.namespace === 'generate_text')).toMatchObject({ status: 'needs_work', source: 'code in ./generate_text/entry.js' })
  })
})

describe('data stores', () => {
  test('literal keys map to state.get / state.set; the value template reads the state key', () => {
    const { draft, report } = convert('data-store.json')
    expect(step(draft.definition.steps, 'get_last')).toMatchObject({ type: 'state.get', keys: ['signups:last_seen'] })
    expect(step(draft.definition.steps, 'save_last')).toMatchObject({ type: 'state.set', state_key: 'signups:last_seen', value: 'steps.get_last.`signups:last_seen`' })
    const notes = report.steps.find(s => s.namespace === 'save_last')?.notes.join(' ') ?? ''
    expect(notes).toContain('TTL')
    expect(notes).toContain('became "signups:last_seen"')
  })
  test('other actions and run-time keys become TODOs pointing at collections', () => {
    const { draft, report } = convert('data-store.json')
    expect(step(draft.definition.steps, 'list_all').type).toBe('check')
    expect(String(step(draft.definition.steps, 'list_all').message)).not.toContain('computed at run time')
    expect(String(step(draft.definition.steps, 'dynamic_key').message)).toContain('computed at run time')
    expect(report.steps.find(s => s.namespace === 'count_in_code')?.notes.join(' ')).toContain('data store')
  })
})

describe('templates', () => {
  const ctx: RefContext = { steps: new Map([['a', { key: 'a', kind: 'code' }], ['t', { key: 't2', kind: 'action' }]]), triggerIsHttp: true }
  test('plain paths', () => {
    expect(pathToJsonata('steps.a.$return_value.x["Record ID"][0]', ctx).expr).toBe('steps.a.x.`Record ID`[0]')
    expect(pathToJsonata(' steps.t.$return_value.id ', ctx).expr).toBe('steps.t2.result.id')
    expect(pathToJsonata('steps.trigger.event.body.email', ctx).expr).toBe('trigger.payload.body.email')
  })
  test('JavaScript and unknown steps are problems, not guesses', () => {
    expect(pathToJsonata('steps.a.$return_value.x.trim()', ctx).problem).toContain('not a plain path')
    expect(pathToJsonata('steps.nope.$return_value', ctx).problem).toContain('not an earlier step')
    expect(pathToJsonata('steps.a.exported', ctx).problem).toContain('$.export')
  })
  test('mixed text joins with &; literals are quoted; a whole-value template keeps its type', () => {
    expect(valueToJsonata('Hi {{steps.a.$return_value.n}}!', ctx).expr).toBe('"Hi " & $string(steps.a.n) & "!"')
    expect(valueToJsonata('{{steps.a.$return_value}}', ctx).expr).toBe('steps.a')
    expect(valueToJsonata({ n: 1, list: ['x', true, null] }, ctx).expr).toBe('{"n": 1, "list": ["x", true, null]}')
  })
  test('literal delays', () => {
    expect(literalNumber('15 * 60 * 1000')).toBe(900000)
    expect(literalNumber('1_000 + 500')).toBe(1500)
    expect(literalNumber('ms')).toBeNull()
  })
})

// Minimal ZIP writer for the test: one stored and one deflated entry.
function makeZip(files: [string, string, boolean][]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, text, deflate] of files) {
    const raw = enc.encode(text)
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const nameB = enc.encode(name)
    const crc = Bun.hash.crc32(raw)
    const local = new Uint8Array(30 + nameB.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, deflate ? 8 : 0, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameB.length, true)
    local.set(nameB, 30)
    const cen = new Uint8Array(46 + nameB.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, deflate ? 8 : 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    cen.set(nameB, 46)
    chunks.push(local, data)
    central.push(cen)
    offset += local.length + data.length
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cenSize, true)
  ev.setUint32(16, offset, true)
  const all = [...chunks, ...central, end]
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of all) {
    out.set(c, p)
    p += c.length
  }
  return out
}

describe('project export', () => {
  const zipPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pd2e-'))
    const p = join(dir, 'project_export-proj_test.zip')
    const read = (f: string) => readFileSync(join(FIX, 'project', f), 'utf8')
    writeFileSync(p, makeZip([
      ['manifest.json', read('manifest.json'), false],
      ['daily-standup-p_one.json', read('daily-standup-p_one.json'), true],
      ['Marketing/lead-webhook-p_two.json', read('Marketing/lead-webhook-p_two.json'), true],
    ]))
    return p
  }
  test('zip and folder give the same result; skipped, missing and truncated are all reported', () => {
    const fromZip = convertProject(loadInput(zipPath()), 'x.zip', {}, new Date(0))
    const fromDir = convertProject(loadInput(join(FIX, 'project')), 'x.zip', {}, new Date(0))
    expect(fromZip.drafts).toEqual(fromDir.drafts)
    expect(fromZip.drafts.map(d => d.file)).toEqual(['daily-standup-reminder-p-one.elaichi.json', 'lead-webhook-p-two.elaichi.json'])
    const nc = fromZip.report.not_converted.map(n => `${n.name}: ${n.reason}`)
    expect(nc).toEqual([
      'Old draft: never deployed in Pipedream, so not exported',
      'Overflow: not exported: the export hit its limit',
      'Missing file: manifest.json lists missing-p_missing.json, but the file is missing',
    ])
    expect(fromZip.report.notes[0]).toContain('stopped this export early')
    const standup = fromZip.report.workflows.find(w => w.name === 'Daily standup reminder')
    expect(standup?.notes).toContain('Pipedream export warning: step send_message: reconnect slack')
    const md = renderMarkdown(fromZip.report)
    for (const s of ['Old draft', 'Overflow', 'Missing file', 'reconnect slack', 'send_message']) expect(md).toContain(s)
  })
  test('the CLI writes drafts and both reports, and exits 1 on a bad input', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pd2e-out-'))
    const logs: string[] = []
    expect(await main([zipPath(), '--out', out, '--toolbox', 'slack=tbx_abc'], {}, l => logs.push(l))).toBe(0)
    expect(readdirSync(out).sort()).toEqual(['daily-standup-reminder-p-one.elaichi.json', 'lead-webhook-p-two.elaichi.json', 'migration-plan.json', 'report.json', 'report.md'])
    const body = JSON.parse(readFileSync(join(out, 'daily-standup-reminder-p-one.elaichi.json'), 'utf8'))
    expect(Object.keys(body)).toEqual(['name', 'description', 'definition'])
    expect(body.definition.toolboxes).toEqual(['tbx_abc'])
    expect(await main([join(FIX, 'README.md'), '--out', out], {}, () => {})).toBe(1)
    expect(await main([join(FIX, 'project'), '--push'], {}, () => {})).toBe(1) // no token
  })
})

describe('push', () => {
  test('only POST /automation is called, with the token; publish and enable never are', async () => {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = []
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ automation: { id: 'auto_1' }, issues: [{ severity: 'error' }, { severity: 'warning' }] }), { status: 201 })
    }) as typeof fetch
    const { draft } = convert('schedule-slack.json')
    const res = await pushDrafts([{ file: 'a.json', body: draft }, { file: 'b.json', body: draft }], { token: 'elch_test', apiUrl: 'https://example.test/', fetch: fake })
    expect(res).toEqual([
      { file: 'a.json', ok: true, id: 'auto_1', issues: 2, errors: 1 },
      { file: 'b.json', ok: true, id: 'auto_1', issues: 2, errors: 1 },
    ])
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['POST https://example.test/automation', 'POST https://example.test/automation'])
    expect(calls[0]?.auth).toBe('Bearer elch_test')
    expect(calls[0]?.body).toEqual(draft)
  })
  test('an API error is reported per draft', async () => {
    const fake = (async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'no automation:create' } }), { status: 403 })) as unknown as typeof fetch
    const { draft } = convert('schedule-slack.json')
    const [r] = await pushDrafts([{ file: 'a.json', body: draft }], { token: 't', fetch: fake })
    expect(r).toEqual({ file: 'a.json', ok: false, error: '403 forbidden no automation:create' })
  })
})
