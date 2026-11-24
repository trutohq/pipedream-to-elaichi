// Code steps. Elaichi runs a code step's `source` as the body of `async function (input)`:
// plain JavaScript, no network, no npm packages, no environment variables.

export interface NodeAnalysis {
  imports: string[]
  network: string[]
  usesEnv: boolean
  dataStoreProps: string[]
  usesExport: boolean
  usesRespond: boolean
  usesExit: boolean
  usesAuth: boolean
  usesFiles: boolean
  delays: { ms: number | null; text: string }[]
  suspends: { timeoutMs: number | null; text: string }[]
  usesResumeUrl: boolean
  usesRerun: boolean
  hasComponent: boolean
  /** Namespaces read as `steps.<ns>` or `steps["<ns>"]`; null when `steps` is indexed dynamically. */
  stepsRead: string[] | null
}

const NETWORK: [RegExp, string][] = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\baxios\b/, 'axios'],
  [/\$\.send\.http\b/, '$.send.http'],
  [/\bgot\s*\(/, 'got()'],
  [/\brequire\s*\(\s*["'](?:node:)?https?["']\s*\)|from\s+["'](?:node:)?https?["']/, 'node http/https'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\$\.send\.(?:email|s3|emit|sse)\b/, '$.send destinations'],
]

/** Evaluates `15 * 60 * 1000`-style literals (digits, `_`, `*`, `+`). Anything else is not literal. */
export function literalNumber(text: string): number | null {
  const t = text.replace(/_/g, '').trim()
  if (!/^[\d\s*+.]+$/.test(t) || t.length === 0) return null
  let total = 0
  for (const term of t.split('+')) {
    const factors = term.split('*').map(f => f.trim())
    if (factors.some(f => !/^\d+(\.\d+)?$/.test(f))) return null
    total += factors.reduce((acc, f) => acc * Number(f), 1)
  }
  return total
}

function callArgs(code: string, callee: RegExp): { arg: string; text: string }[] {
  const out: { arg: string; text: string }[] = []
  for (const m of code.matchAll(callee)) {
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') depth--
      i++
    }
    const inner = code.slice(start, i - 1)
    const firstArg = inner.split(',')[0] ?? ''
    out.push({ arg: firstArg.trim(), text: code.slice(m.index ?? 0, i) })
  }
  return out
}

export function analyzeNode(code: string): NodeAnalysis {
  const imports = [...code.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm)].map(m => m[1] ?? '')
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) imports.push(m[1] ?? '')
  const dataStoreProps = [...code.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{\s*type\s*:\s*["']data_store["']/g)].map(m => m[1] ?? '')
  // `steps` used whole (destructured, passed on, renamed in run's arguments) means every earlier result is needed.
  const sig = /\brun\s*\(\s*\{([^}]*)\}/.exec(code)
  const renamed = sig ? /\bsteps\s*:/.test(sig[1] ?? '') : false
  const rest = sig ? code.replace(sig[0], 'run(') : code
  const usedWhole = /\bsteps\b(?!\s*(?:\.\s*[A-Za-z_$]|\[\s*["']))/.test(rest)
  const stepsDynamic = /\bsteps\s*\[\s*[^"'\s]/.test(code) || renamed || usedWhole
  const read = new Set<string>()
  for (const m of code.matchAll(/\bsteps\.([A-Za-z_$][\w$]*)/g)) read.add(m[1] ?? '')
  for (const m of code.matchAll(/\bsteps\s*\[\s*["']([^"']+)["']\s*\]/g)) read.add(m[1] ?? '')
  return {
    imports: [...new Set(imports)].filter(Boolean),
    network: NETWORK.filter(([re]) => re.test(code)).map(([, label]) => label),
    usesEnv: /\bprocess\.env\b/.test(code),
    dataStoreProps,
    usesExport: /\$\.export\s*\(/.test(code),
    usesRespond: /\$\.respond\s*\(/.test(code),
    usesExit: /\$\.flow\.exit\s*\(/.test(code),
    usesAuth: /\.\$auth\b/.test(code),
    usesFiles: /["'`]\/tmp\b|\$\.files\b|\bfs\.\w+/.test(code),
    delays: callArgs(code, /\$\.flow\.delay\s*\(/g).map(c => ({ ms: literalNumber(c.arg), text: c.text })),
    suspends: callArgs(code, /\$\.flow\.suspend\s*\(/g).map(c => ({ timeoutMs: c.arg === '' ? null : literalNumber(c.arg), text: c.text })),
    usesResumeUrl: /\bresume_url\b|\bcancel_url\b/.test(code),
    usesRerun: /\$\.flow\.rerun\s*\(/.test(code),
    hasComponent: /export\s+default\s+defineComponent\s*\(/.test(code) || /export\s+default\s*\{/.test(code),
    stepsRead: stepsDynamic ? null : [...read].filter(Boolean),
  }
}

const IMPORT_STATEMENT = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s*)?["'][^"'\n]+["'][ \t]*;?|^[ \t]*(?:const|let|var)\s+[^=;]+=\s*(?:await\s+)?require\s*\(\s*["'][^"'\n]+["']\s*\)[^;\n]*;?/gm

/** Comments out every `import` statement (also over several lines) and `require(...)` line, since Elaichi code cannot load packages. */
export function commentImports(code: string): string {
  return code.replace(IMPORT_STATEMENT, stmt =>
    stmt
      .split('\n')
      .map(line => `// TODO (no npm packages in Elaichi): ${line}`)
      .join('\n'),
  )
}

/**
 * Wraps a Pipedream Node.js component so it runs unchanged as an Elaichi code step.
 * `input.steps` holds the earlier results under their Pipedream names (`steps.<ns>.$return_value`,
 * `steps.trigger.event`), and `input.props` the configured props. Props and the component's
 * `methods` are bound to `this`, as Pipedream does.
 * `$.flow.exit()` returns a marker that the filter step after this one stops on.
 */
export function nodeShim(code: string, namespace: string): string {
  const body = commentImports(code)
    .replace(/export\s+default\s+defineComponent\s*\(/, 'const __component = defineComponent(')
    .replace(/export\s+default\s*\{/, 'const __component = {')
  return [
    `// Pipedream step "${namespace}", imported by pipedream-to-elaichi. Review before you publish.`,
    '// Elaichi runs this as the body of `async function (input)`: no network, no npm packages, no process.env.',
    'const steps = input.steps || {};',
    'let __exit = null;',
    'const $ = {',
    '  export: (name, value) => { /* TODO: $.export values are not passed on; return them instead. */ },',
    '  flow: {',
    '    exit: (reason) => { __exit = { __pd_flow_exit: true, reason: reason === undefined ? null : reason }; return __exit; },',
    '    delay: () => ({}), // replaced by the wait step after this one',
    '    suspend: () => ({}), // replaced by the approve step after this one',
    "    rerun: () => { throw new Error('TODO: $.flow.rerun has no Elaichi equivalent; use a step retry or repeat'); },",
    '  },',
    '  respond: () => {}, // Elaichi answers webhooks with 202 itself',
    '};',
    'const defineComponent = (c) => c;',
    body,
    'const __this = Object.assign({}, input.props || {});',
    'for (const [name, fn] of Object.entries(__component.methods || {})) __this[name] = fn;',
    'const __result = await __component.run.call(__this, { steps, $ });',
    'return __exit || __result;',
  ].join('\n')
}

const LANG_NAMES: [RegExp, string, string][] = [
  [/^python/i, 'Python', 'py'],
  [/^go/i, 'Go', 'go'],
  [/^bash|^shell/i, 'Bash', 'sh'],
  [/^node|^javascript/i, 'Node.js', 'js'],
]

export function languageOf(runtime: string | undefined, code: string): { name: string; ext: string } {
  const r = runtime ?? ''
  for (const [re, name, ext] of LANG_NAMES) if (re.test(r)) return { name, ext }
  if (/^\s*def\s+handler\s*\(\s*pd\b/m.test(code)) return { name: 'Python', ext: 'py' }
  if (/^\s*package\s+main\b/m.test(code)) return { name: 'Go', ext: 'go' }
  if (/^#!.*\b(ba)?sh\b/.test(code)) return { name: 'Bash', ext: 'sh' }
  return { name: 'Node.js', ext: 'js' }
}

/** A code step that keeps the original source in a comment and fails until someone ports it. */
export function placeholderSource(code: string, language: string, namespace: string): string {
  const safe = code.replace(/\*\//g, '*\\/')
  return [
    `// Pipedream step "${namespace}" was ${language}. Elaichi code steps run JavaScript only.`,
    '// Port the code below to JavaScript, read earlier results from `input`, return the result, then delete the throw.',
    '/*',
    safe,
    '*/',
    `throw new Error(${JSON.stringify(`TODO: port the ${language} step "${namespace}" to JavaScript`)});`,
  ].join('\n')
}

export interface ForeignAnalysis {
  /** Packages or modules beyond the small standard-library set whose job plain JavaScript does. */
  packages: string[]
  network: string[]
  usesEnv: boolean
  usesFiles: boolean
  /** Pipedream helpers the code calls (pd.export, pd.flow.exit, …). */
  pdApis: string[]
}

const PY_PLAIN = new Set(['json', 're', 'datetime', 'math', 'time', 'random', 'uuid', 'typing', 'collections', 'itertools', 'functools', 'string', 'decimal', 'statistics', 'copy', 'enum', 'dataclasses', 'textwrap', 'base64', 'os', 'sys', 'hashlib', 'hmac', 'csv', 'logging', 'urllib.parse', 'html', 'zoneinfo', 'calendar', 'pprint', 'operator', 'secrets'])
const GO_PLAIN = new Set(['fmt', 'strings', 'strconv', 'encoding/json', 'time', 'math', 'sort', 'regexp', 'errors', 'unicode', 'bytes', 'encoding/base64', 'log', 'io', 'net/url', 'context', 'os', 'github.com/PipedreamHQ/pipedream-go'])
const PY_NET: [RegExp, string][] = [[/\brequests\b/, 'requests'], [/\bhttpx\b/, 'httpx'], [/\burllib\.request\b|\burlopen\b|\burllib3\b/, 'urllib'], [/\baiohttp\b/, 'aiohttp'], [/\bhttp\.client\b/, 'http.client']]
const pyPlain = (mod: string) => PY_PLAIN.has(mod) || PY_PLAIN.has(mod.split('.')[0] ?? '') && mod.split('.')[0] !== 'urllib'
const SH_NET: [RegExp, string][] = [[/\bcurl\b/, 'curl'], [/\bwget\b/, 'wget']]

/** What a Python, Go or Bash step uses, so the report can say whether porting it to JavaScript is enough. */
export function analyzeForeign(code: string, language: string): ForeignAnalysis {
  let packages: string[] = []
  let network: string[] = []
  let usesEnv = false
  const pdApis = new Set<string>()
  if (language === 'Python') {
    const mods = [...code.matchAll(/^\s*(?:import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)|from\s+([\w.]+)\s+import)/gm)].flatMap(m =>
      m[1] ? m[1].split(',').map(x => x.trim().split(/\s+/)[0] ?? '') : [m[2] ?? ''],
    )
    packages = mods.filter(m => m && !pyPlain(m) && !PY_NET.some(([re]) => re.test(m)) && m.split('.')[0] !== 'requests')
    network = PY_NET.filter(([re]) => re.test(code)).map(([, l]) => l)
    usesEnv = /\bos\.(environ|getenv)\b/.test(code)
    for (const m of code.matchAll(/\bpd\.(export|respond|flow\.\w+|send\.\w+)\b/g)) pdApis.add(`pd.${m[1]}`)
  } else if (language === 'Go') {
    const block = /\bimport\s*\(([\s\S]*?)\)/.exec(code)?.[1] ?? ''
    const single = [...code.matchAll(/\bimport\s+"([^"]+)"/g)].map(m => m[1] ?? '')
    const mods = [...[...block.matchAll(/"([^"]+)"/g)].map(m => m[1] ?? ''), ...single]
    packages = mods.filter(m => m && !GO_PLAIN.has(m) && m !== 'net/http')
    if (mods.includes('net/http')) network.push('net/http')
    usesEnv = /\bos\.Getenv\b/.test(code)
    for (const m of code.matchAll(/\bpd\.(Export|Respond|Flow\w*)\b/g)) pdApis.add(`pd.${m[1]}`)
  } else {
    network = SH_NET.filter(([re]) => re.test(code)).map(([, l]) => l)
    packages = [...code.matchAll(/\b(apt-get|pip3?|npm|brew)\s+install\b/g)].map(m => m[1] ?? '')
    // An upper-case variable the script never sets itself comes from the environment.
    const assigned = new Set([...code.matchAll(/(?:^|[\s;(])(?:export\s+|local\s+|read\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=/gm)].map(m => m[1]))
    for (const m of code.matchAll(/\bread\s+(?:-\w+\s+)*([A-Za-z_]\w*)/g)) assigned.add(m[1])
    usesEnv = [...code.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\b/g)].some(m => !m[1]?.startsWith('PIPEDREAM_') && !assigned.has(m[1]))
    for (const m of code.matchAll(/\$\{?(PIPEDREAM_\w+)/g)) pdApis.add(`$${m[1]}`)
  }
  return {
    packages: [...new Set(packages)],
    network,
    usesEnv,
    usesFiles: /["'`]\/tmp\b|\bos\.(Open|Create|ReadFile|WriteFile)\b/.test(code) || (language === 'Bash' && /\/tmp\b/.test(code)),
    pdApis: [...pdApis],
  }
}
