// One check per finding from the first independent review.
import { describe, expect, test } from 'bun:test'
import { analyzeNode, commentImports, nodeShim } from '../src/code.ts'
import { convertWorkflow, minGap, minutesOf } from '../src/convert.ts'
import { parseWorkflow } from '../src/parse.ts'
import { pathToJsonata } from '../src/templates.ts'
import type { Step } from '../src/types.ts'

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (input: unknown) => Promise<unknown>
const wf = (raw: Record<string, unknown>) => convertWorkflow(parseWorkflow({ name: 'probe', triggers: [], steps: [], ...raw }, 'probe.json'), { toolboxes: { slack: 'tbx_1' } })
const code = (namespace: string, src: string, extra: Record<string, unknown> = {}) => ({ namespace, lang: 'nodejs20.x', uses: { registry: false, code: src }, ...extra })
const component = (run: string, more = '') => `export default defineComponent({\n${more}  async run({ steps, $ }) {\n${run}\n  },\n});\n`

describe('code wrapper', () => {
  test('component methods are bound to this, as in Pipedream', async () => {
    const src = nodeShim(component('    return this.dbl(this.n);', '  methods: { dbl(x) { return x * 2; } },\n'), 'c')
    expect(await new AsyncFunction('input', src)({ props: { n: 21 } })).toBe(42)
  })
  test('a multi-line import is commented out on every line', async () => {
    const out = commentImports('import {\n  a,\n  b\n} from "zz";\nconst x = require("y");\nexport default 1')
    expect(out.split('\n').slice(0, 5).every(l => l.startsWith('// TODO'))).toBe(true)
    expect(out.endsWith('export default 1')).toBe(true)
    const src = nodeShim(`import {\n  a,\n  b\n} from "zz";\n${component('    return 1;')}`, 'c')
    expect(await new AsyncFunction('input', src)({})).toBe(1)
  })
  test('steps used whole (destructured, passed on, renamed) means every earlier result is passed in', () => {
    expect(analyzeNode(component('    const { a } = steps; return a;')).stepsRead).toBeNull()
    expect(analyzeNode(component('    return JSON.stringify(steps);')).stepsRead).toBeNull()
    expect(analyzeNode('export default defineComponent({ async run({ steps: s, $ }) { return s.a } })').stepsRead).toBeNull()
    expect(analyzeNode(component('    return steps.a.$return_value;')).stepsRead).toEqual(['a'])
    const { draft } = wf({ steps: [code('a', component('    return 1;')), code('b', component('    const { a } = steps; return a.$return_value;'))] })
    expect(String(draft.definition.steps.find(s => s.key === 'b')?.input)).toContain('"a": {"$return_value": steps.a}')
  })
})

describe('steps', () => {
  test('a disabled code step switches off its wait, filter and approve steps too', () => {
    const { draft } = wf({ steps: [code('c3', component('    await $.flow.delay(1000); return $.flow.exit("x");'), { disabled: true })] })
    const made = draft.definition.steps.filter(s => s.key.startsWith('c3'))
    expect(made.map(s => s.type).sort()).toEqual(['code', 'filter', 'wait'])
    for (const s of made) expect(s.run_if).toBe('false')
  })
  test('Slack props the argument mapper does not read are reported, not dropped', () => {
    const { draft, report } = wf({
      steps: [{ namespace: 'post', props: { slack: { authProvisionId: 'apn_1' }, conversation: 'C1', text: 'hi', thread_ts: '123.4', username: 'bot' }, uses: { registry: true, key: 'slack_v2-send-message-to-channel' } }],
    })
    const r = report.steps[0]
    expect(r?.status).toBe('needs_work')
    expect(r?.notes.join(' ')).toContain('thread_ts="123.4"')
    expect(r?.notes.join(' ')).toContain('username="bot"')
    expect(draft.definition.steps[0]?.key).toBe('import_review')
  })
  test('a JavaScript property such as .length is flagged, not read as a field', () => {
    const ctx = { steps: new Map([['c1', { key: 'c1', kind: 'code' as const }]]), triggerIsHttp: true }
    const r = pathToJsonata('steps.c1.$return_value.items.length', ctx)
    expect(r.expr).toBeUndefined()
    expect(r.problem).toContain('JavaScript property')
    expect(pathToJsonata('steps.trigger.event.body.length', ctx).problem).toContain('JavaScript property')
  })
})

describe('control flow and settings', () => {
  test('branches get their own needs-work report row and the review gate', () => {
    const { draft, report } = wf({
      triggers: [{ type: 'timer', props: { cron: '*/10 * * * *' } }],
      steps: [code('a', component('    return 1;'))],
      deployments: { d1: { steps: [code('b', component('    return 2;'))] } },
    })
    const row = report.steps.find(s => s.source === 'deployments')
    expect(row?.status).toBe('needs_work')
    expect(row?.elaichi_keys).toEqual(['control_flow'])
    expect(report.steps.find(s => s.namespace === 'b')?.notes.join(' ')).toContain('switched off')
    expect(draft.definition.steps[0]?.key).toBe('import_review')
  })
  test('deployments in an unknown shape get a no-match row; settings get a note', () => {
    const { draft, report } = wf({ deployments: { b: { nodes: [{ x: 1 }] } }, settings: { retries: 3 } })
    expect(report.steps.find(s => s.source === 'deployments')?.status).toBe('no_match')
    expect(report.notes.join(' ')).toContain('settings not carried over: retries')
    expect(draft.definition.steps[0]?.key).toBe('import_review')
  })
})

describe('triggers', () => {
  const cronOf = (t: Step | undefined) => String((t as { cron?: string } | undefined)?.cron)
  test('minute ranges and lists under 5 minutes apart are thinned and flagged', () => {
    expect(minutesOf('0-10')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(minutesOf('5/20')).toEqual([5, 25, 45])
    expect(minGap([0, 58], true)).toBe(2)
    expect(minGap([0, 58], false)).toBe(58)
    const { draft, report } = wf({ triggers: [{ type: 'timer', props: { cron: '0-10 * * * *' } }, { type: 'timer', props: { cron: '0,2 9 * * *', timezone: 'UTC' } }, { type: 'timer', props: { cron: '15,45 * * * *' } }] })
    const crons = draft.definition.triggers.filter(t => t.type === 'cron')
    expect(crons.map(t => cronOf(t as unknown as Step))).toEqual(['0,5,10 * * * *', '0 9 * * *', '15,45 * * * *'])
    expect(report.triggers.map(t => t.status)).toEqual(['needs_work', 'needs_work', 'mapped'])
  })
  test('a disabled trigger is reported and not added; unread trigger settings are reported', () => {
    const { draft, report } = wf({ triggers: [{ type: 'timer', disabled: true, props: { cron: '0 9 * * *' } }, { type: 'http', props: { method: 'POST', auth: '<redacted>' } }] })
    expect(draft.definition.triggers.some(t => t.type === 'cron')).toBe(false)
    expect(report.triggers[0]?.status).toBe('needs_work')
    expect(report.triggers[0]?.notes.join(' ')).toContain('Disabled in Pipedream')
    expect(report.triggers[1]?.notes.join(' ')).toContain('auth="<redacted>"')
  })
})
