// The parts an AI coding agent relies on: todo kinds in report.json, the check / validate commands, and the skill files.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDefinition, findTodos } from '../src/check.ts'
import { main } from '../src/cli.ts'
import { analyzeForeign } from '../src/code.ts'
import { convertWorkflow } from '../src/convert.ts'
import { parseWorkflow } from '../src/parse.ts'
import type { MigrationPlan } from '../src/plan.ts'
import { validateDrafts } from '../src/push.ts'
import type { DraftBody, Step } from '../src/types.ts'

const ROOT = join(import.meta.dir, '..')
const FIX = join(import.meta.dir, 'fixtures')
const FIXTURES = ['schedule-slack.json', 'http-respond.json', 'delay-suspend.json', 'polyglot.json', 'data-store.json', 'apps.json', 'github-sync-style.json']
const convert = (name: string) => convertWorkflow(parseWorkflow(JSON.parse(readFileSync(join(FIX, name), 'utf8')), name))
const capture = () => {
  const lines: string[] = []
  return { lines, log: (s: string) => lines.push(s) }
}

describe('todo kinds in the report', () => {
  for (const name of FIXTURES)
    test(`${name}: a step has todo kinds exactly when it is not mapped`, () => {
      for (const r of convert(name).report.steps) expect(r.todo.length > 0).toBe(r.status !== 'mapped')
    })
  test('Python with requests needs tool calls; plain Python only needs porting', () => {
    const wf = (src: string) =>
      convertWorkflow(parseWorkflow({ name: 'p', triggers: [], steps: [{ namespace: 'py', lang: 'python3.12', uses: { registry: false, code: src } }] }, 'p.json')).report.steps[0]
    const net = wf('import requests\ndef handler(pd: "pipedream"):\n    return requests.get("https://x").json()')
    expect(net?.todo).toEqual(['port_code', 'rebuild_with_tools'])
    const plain = wf('import json\ndef handler(pd: "pipedream"):\n    return json.dumps(pd.steps["trigger"]["event"])')
    expect(plain?.todo).toEqual(['port_code'])
    expect(plain?.notes.join(' ')).toContain('Plain logic only')
  })
  test('foreign-code analysis per language', () => {
    expect(analyzeForeign('import (\n "fmt"\n "net/http"\n "github.com/x/y"\n)\nfunc main(){ os.Getenv("K") }', 'Go')).toMatchObject({ network: ['net/http'], packages: ['github.com/x/y'], usesEnv: true })
    expect(analyzeForeign('cat $PIPEDREAM_STEPS | jq .x\ncurl -s https://x > /tmp/a\necho "k:json=1" >> $PIPEDREAM_EXPORTS', 'Bash')).toMatchObject({ network: ['curl'], usesFiles: true, pdApis: ['$PIPEDREAM_STEPS', '$PIPEDREAM_EXPORTS'] })
  })
})

describe('check command', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2e-check-'))
    const { draft } = convert('polyglot.json')
    writeFileSync(join(dir, 'w.elaichi.json'), JSON.stringify(draft))
    return { dir, draft }
  }
  test('lists open TODOs and fails while any are left', async () => {
    const { dir } = setup()
    const { lines, log } = capture()
    expect(await main(['check', dir], {}, log)).toBe(1)
    expect(lines.join('\n')).toContain('code not ported yet')
  })
  test('passes once every TODO is fixed, and still names the review gate', async () => {
    const { dir, draft } = setup()
    const fixSteps = (steps: Step[]) => {
      for (const s of steps) {
        if (s.type === 'code') s.source = 'return 1'
        if (typeof s.name === 'string' && s.name.startsWith('TODO') && s.key !== 'import_review') s.name = s.key
        if (typeof s.description === 'string' && s.description.startsWith('TODO')) s.description = 'Ported.'
      }
    }
    fixSteps(draft.definition.steps)
    writeFileSync(join(dir, 'w.elaichi.json'), JSON.stringify(draft))
    const { lines, log } = capture()
    expect(await main(['check', dir, '--json'], {}, log)).toBe(0)
    const out = JSON.parse(lines.join('\n')) as { ok: boolean; drafts: { reviewGate: boolean; todos: string[] }[] }
    expect(out.ok).toBe(true)
    expect(out.drafts[0]?.reviewGate).toBe(true)
  })
  test('placeholder toolboxes and switched-off branch arms count as TODOs', () => {
    const def = { schema_version: 1, triggers: [], toolboxes: ['tbx_REPLACE_slack'], steps: [{ key: 'b', type: 'branch', branches: [{ key: 'a', when: 'false', steps: [{ key: 'c', type: 'call_tool', toolbox_id: 'tbx_REPLACE_slack', tool: 't' }] }] }] } as unknown as DraftBody['definition']
    const { todos } = findTodos(def)
    expect(todos.some(t => t.includes('placeholder'))).toBe(true)
    expect(todos.some(t => t.includes('switched off'))).toBe(true)
  })
  test('validate and push need a token', async () => {
    const { dir } = setup()
    for (const cmd of ['validate', 'push']) expect(await main([cmd, dir], {}, () => {})).toBe(1)
  })
})

describe('validate', () => {
  test('only calls POST /automation/validate with the definition, and reads errors', async () => {
    const calls: { url: string; method?: string; body: unknown }[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ definition_valid: true, issues: [{ severity: 'error', code: 'toolbox_not_found', message: 'no such toolbox' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { draft } = convert('schedule-slack.json')
    const [r] = await validateDrafts([{ file: 'a.elaichi.json', body: draft }], { token: 'elch_test', fetch: fakeFetch, apiUrl: 'https://example.test/' })
    expect(calls).toEqual([{ url: 'https://example.test/automation/validate', method: 'POST', body: { definition: draft.definition } }])
    expect(r?.ok).toBe(false)
    expect(r?.issues?.[0]?.code).toBe('toolbox_not_found')
  })
})

describe('check finds every open item (second review)', () => {
  for (const name of FIXTURES)
    test(`${name}: each step row that is not mapped has a TODO marker check can see`, () => {
      const { draft, report } = convert(name)
      const { todos } = findTodos(draft.definition)
      for (const r of report.steps.filter(s => s.status !== 'mapped')) expect(todos.some(t => r.elaichi_keys.some(k => t.startsWith(`step ${k}:`)) || t.startsWith('toolboxes:'))).toBe(true)
    })
  test('unreadable deployments leave a TODO step in the draft', () => {
    const { draft, report } = convertWorkflow(parseWorkflow({ name: 'd', triggers: [], steps: [], deployments: { x: { nodes: [1] } } }, 'd.json'))
    const row = report.steps.find(s => s.source === 'deployments')
    expect(row?.elaichi_keys).toEqual(['control_flow_todo'])
    expect(findTodos(draft.definition).todos.some(t => t.startsWith('step control_flow_todo:'))).toBe(true)
  })
  test('wait with until, else arms and a step named "TODO list sync"', () => {
    const def = {
      schema_version: 1,
      triggers: [{ key: 'manual', type: 'manual' }],
      toolboxes: [],
      steps: [
        { key: 'w', type: 'wait', until: 'trigger.payload.at' },
        { key: 'todo_list_sync', type: 'filter', name: 'TODO list sync', condition: 'true' },
        { key: 'b', type: 'branch', branches: [{ key: 'a', when: 'true', steps: [{ key: 'x', type: 'filter', condition: 'true' }] }], else: [{ key: 'e', type: 'check', assert: 'false', message: '"x"' }] },
      ],
    } as unknown as DraftBody['definition']
    expect(checkDefinition(def, { strict: false })).toEqual([])
    expect(findTodos(def).todos).toEqual(['step e: TODO step "" still holds a Pipedream step\'s place'])
  })
  test('an edited draft missing triggers is reported, not a crash', () => {
    expect(checkDefinition({ schema_version: 1, steps: [] } as unknown as DraftBody['definition'], { strict: false })).toEqual(['definition: triggers must be a list'])
  })
  test('analyzer: standard modules are not packages, urllib.parse is not network, local Bash variables are not env', () => {
    expect(analyzeForeign('import os, sys\nimport hashlib\nfrom urllib.parse import quote\ndef handler(pd): return 1', 'Python')).toMatchObject({ packages: [], network: [] })
    expect(analyzeForeign('import pandas as pd2, json', 'Python').packages).toEqual(['pandas'])
    expect(analyzeForeign('import (\n "log"\n "io"\n "net/url"\n "context"\n)', 'Go').packages).toEqual([])
    expect(analyzeForeign('R=$(cat $PIPEDREAM_STEPS | jq .x)\necho $R', 'Bash').usesEnv).toBe(false)
    expect(analyzeForeign('echo $API_KEY', 'Bash').usesEnv).toBe(true)
  })
})

describe('migration-plan.json', () => {
  test('lists every open step and trigger, with the original code and the limits explained', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2e-plan-'))
    return main([join(FIX, 'http-respond.json'), '--out', dir], {}, () => {}).then(code => {
      expect(code).toBe(0)
      const plan = JSON.parse(readFileSync(join(dir, 'migration-plan.json'), 'utf8')) as MigrationPlan
      const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { workflows: { steps: { status: string }[]; triggers: { status: string }[] }[] }
      const w = report.workflows[0]
      const open = (w?.steps.filter(s => s.status !== 'mapped').length ?? 0) + (w?.triggers.filter(t => t.status !== 'mapped').length ?? 0)
      expect(plan.workflows[0]?.items.length).toBe(open)
      const enrich = plan.workflows[0]?.items.find(i => i.pipedream_step === 'enrich')
      expect(enrich?.original?.code).toContain('axios')
      expect(enrich?.limits).toContain('code_no_network')
      for (const item of plan.workflows.flatMap(x => x.items)) for (const l of item.limits) expect(plan.limits[l]?.instead.length).toBeGreaterThan(0)
      expect(JSON.stringify(plan)).not.toContain('apn_')
    })
  })
})

describe('agent files', () => {
  test('each skill follows the Agent Skills format', () => {
    const dir = join(ROOT, 'skills')
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
      expect(/^name: (.+)$/m.exec(front)?.[1]).toBe(name)
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      const description = /^description: (.+)$/m.exec(front)?.[1] ?? ''
      expect(description.length).toBeGreaterThan(0)
      expect(description.length).toBeLessThanOrEqual(1024)
      expect(text.split('\n').length).toBeLessThan(500)
      for (const m of text.matchAll(/\]\((references\/[^)]+)\)/g)) expect(readFileSync(join(dir, name, m[1] ?? ''), 'utf8').length).toBeGreaterThan(0)
    }
  })
  test('the Claude Code marketplace lists this repo as its plugin', () => {
    const m = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; owner: { name: string }; plugins: { name: string; source: string }[] }
    expect(m.owner.name.length).toBeGreaterThan(0)
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'pipedream-to-elaichi', source: './' })])
  })
  test('CLAUDE.md imports AGENTS.md', () => {
    expect(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md')
  })
})

describe('converting again', () => {
  test('refuses to overwrite drafts in --out unless --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2e-force-'))
    const input = join(FIX, 'polyglot.json')
    expect(await main([input, '--out', dir], {}, () => {})).toBe(0)
    const file = join(dir, readdirSync(dir).find(f => f.endsWith('.elaichi.json')) ?? '')
    writeFileSync(file, '{"edited": true}')
    const { lines, log } = capture()
    expect(await main([input, '--out', dir], {}, log)).toBe(1)
    expect(lines.join('\n')).toContain('--force')
    expect(readFileSync(file, 'utf8')).toBe('{"edited": true}')
    expect(await main([input, '--out', dir, '--force'], {}, () => {})).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toBe('{"edited": true}')
  })
})
