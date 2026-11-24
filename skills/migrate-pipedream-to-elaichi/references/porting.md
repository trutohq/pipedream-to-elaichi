# Porting Pipedream code to an Elaichi code step

## The Elaichi code step

```json
{
  "key": "score",
  "type": "code",
  "name": "Score the lead",
  "language": "javascript",
  "input": "{\"lead\": steps.fetch_lead.result, \"event\": trigger.payload.body}",
  "source": "const { lead } = input;\nreturn { score: lead.employees > 100 ? 'high' : 'low' };"
}
```

- `source` is the **body** of `async function (input)`. Use `return` for the result and `await` where needed. JavaScript only.
- `input` is a JSONata string. Its value is the `input` argument. Pass everything the code reads; the code cannot see other steps itself.
- The return value is the step's output. Later steps read it as `steps.<key>` (for example `steps.score.score`).
- No network (`fetch` fails), no npm packages, no `process.env`, no file system. Anything the code fetched must come from a `call_tool` step before it, passed in through `input`.
- At most 64 KB of source, and at most 10 code steps per workflow.

## Pipedream → Elaichi, by language

### Node.js (wrapped, not ported)

The importer keeps Node.js components as they are, inside a wrapper: `input.steps` holds earlier results under their Pipedream names (`steps.<name>.$return_value`, `steps.trigger.event`), and `input.props` holds the configured props, bound to `this` with the component's `methods`. Fix only what the notes flag:

| Pipedream | Elaichi |
|---|---|
| `import x from "pkg"` / `require("pkg")` | Commented out by the importer. Rewrite the code without the package, or move the work to a tool. |
| `fetch`, `axios`, `$.send.http`, `got` | A `call_tool` step before this one; read its result from `input`. |
| `this.<app>.$auth` | A `call_tool` step. Code never sees credentials. |
| `process.env.X` | Put the value in the step's `input` (or a workflow setting) and read `input.X`. |
| `$.export("name", v)` | Return it: `return { ...result, name: v }`. |
| `$.flow.exit(reason)` | Already handled: the wrapper returns a marker, and a `filter` step after this one skips the rest. |
| `$.flow.delay(ms)` | Already a `wait` step after this one (at most 3600 seconds). |
| `$.flow.suspend()` | Already an `approve` step after this one. Delete only the lines that send `resume_url` or `cancel_url` (to Slack, email…); keep the rest and still return what later steps read. If the message also told people what to approve, put that text in the approve step's `title` or `message` instead. |
| `$.respond(...)` | Remove it. Elaichi answers webhooks with 202. |
| Data store props (`this.store.get/set`) | A `state.get` step before and a `state.set` step after (state keys are fixed strings), or a collection. |

### Python

Pipedream: `def handler(pd: "pipedream"):`. Rewrite as plain JavaScript in `source`; delete the comment block and the `throw` line.

| Python | JavaScript in Elaichi |
|---|---|
| `pd.steps["trigger"]["event"]["body"]` | `input.event.body`, with `input` set to `{"event": trigger.payload}` |
| `pd.steps["step_name"]["$return_value"]` or an exported key | `input.<name>`, with `input` set to `{"<name>": steps.<elaichi_key>}` (`.result` for a `call_tool` step) |
| `return {"k": v}` | `return { k: v }` |
| `return pd.flow.exit("reason")` | Add a `filter` step after this one with a condition on the returned value, or a `run_if` on the next steps. |
| `pd.respond(...)` | Remove it. |
| `json.loads` / `json.dumps` | `JSON.parse` / `JSON.stringify` |
| `re.search(p, s)` | `s.match(new RegExp(p))` |
| `datetime.now(timezone.utc).isoformat()` | `new Date().toISOString()` |
| `requests.get/post`, `httpx`, `urllib` | Not in code: a `call_tool` step (kind `rebuild_with_tools`). |
| `os.environ["X"]` | `input.X`, passed in `input`. |
| `pandas`, other packages | Rewrite with plain arrays and objects, or move the work to a tool or an `agent` step. Say so if it is too big. |

### Go

Pipedream: `package main` with `pd "github.com/PipedreamHQ/pipedream-go"`. Rewrite as JavaScript:

| Go | JavaScript in Elaichi |
|---|---|
| `pd.Steps["trigger"].(map[string]interface{})["event"]` | `input.event`, with `input` set to `{"event": trigger.payload}` |
| `pd.Steps["step_name"]` | `input.<name>`, with `input` set to `{"<name>": steps.<elaichi_key>}` |
| `pd.Export("k", v)` (each one) | one field of the returned object: `return { k: v }` |
| `fmt.Println(...)` | `console.log(...)` or nothing. It was only a log line, not a result. |
| `os.Exit(1)` / a returned error | `throw new Error("...")` |
| `net/http` calls | `call_tool` steps (kind `rebuild_with_tools`) |
| `os.Getenv("X")` | `input.X`, passed in `input` |

### Bash

Pipedream reads earlier steps with `cat $PIPEDREAM_STEPS | jq …` and exports with `echo "key:json=${DATA}" >> $PIPEDREAM_EXPORTS`. **Only lines written to `$PIPEDREAM_EXPORTS` were results. Everything else a Bash step printed was a log line**, so `echo "hello"` on its own ports to nothing (or `console.log("hello")`), not to a returned value.

| Bash | JavaScript in Elaichi |
|---|---|
| `cat $PIPEDREAM_STEPS \| jq .trigger.event.body` | `input.event.body`, with `input` set to `{"event": trigger.payload}` |
| `echo "key:json=$DATA" >> $PIPEDREAM_EXPORTS` | `return { key: data }` (all exports in one returned object) |
| `echo` / `printf` to stdout | `console.log(...)`, or drop it |
| `exit 1` | `throw new Error("...")` |
| `jq`, `sed`, `awk` on JSON or text | Plain JavaScript on objects and strings |
| `curl`, `wget` | `call_tool` steps (kind `rebuild_with_tools`) |
| `$NAME` the script never sets | `input.NAME`, passed in `input` |

A step with no exports and no side effect other than logging has no job in Elaichi. Say so, and suggest deleting it instead of porting it.

## The trigger is a placeholder

When the Pipedream trigger could not be converted (app event source, email, form), the draft has a `manual` trigger and `trigger.payload` does not have the Pipedream event's shape. Keep the read in `input` (`{"event": trigger.payload}`), and tell the person the path must be checked once the real trigger is set up. Do not guess field names.

## JavaScript inside `{{ }}` in action props

Pipedream props can hold JavaScript (`{{steps.x.$return_value.name.toUpperCase()}}`). Elaichi `args` are JSONata. The importer flags these and leaves them as text. Rewrite each:

| JavaScript | JSONata |
|---|---|
| `a.toUpperCase()` / `a.toLowerCase()` | `$uppercase(a)` / `$lowercase(a)` |
| `arr.length` / `str.length` | `$count(arr)` / `$length(str)` |
| `arr.join(", ")` | `$join(arr, ", ")` |
| `` `Hi ${name}` `` | `"Hi " & name` |
| `JSON.stringify(x)` | `$string(x)` |
| `a ? b : c` | `a ? b : c` (same) |
| `arr.map(x => x.id)` | `arr.id` |
| `new Date().toISOString()` | `$now()` |

## Check your port

- Run the CLI `check` command: the step must no longer show "code not ported yet".
- Validate (`automation.draft.validate`, or the CLI `validate` command): the code step must have no error.
- With MCP, `automation.dry_run` runs the code on real data. Compare the output with what Pipedream returned, if the person has an example.
