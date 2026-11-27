# AGENTS.md

This repository is `pipedream-to-elaichi`: a Bun/TypeScript CLI that turns Pipedream workflow exports into Elaichi workflow drafts and a migration report.

## If the person wants to migrate their Pipedream workflows

Follow [skills/migrate-pipedream-to-elaichi/SKILL.md](skills/migrate-pipedream-to-elaichi/SKILL.md). In short:

1. `bun src/cli.ts <export.zip | folder | workflow.json> --out elaichi-drafts`
2. Work through `elaichi-drafts/migration-plan.json`: each item has `kinds`, `reasons`, the `original` Pipedream code or action, and the Elaichi `limits` it hits. The skill says what to do for each kind. Port code by [references/porting.md](skills/migrate-pipedream-to-elaichi/references/porting.md).
3. Edit the drafts, then `bun src/cli.ts check elaichi-drafts` until it passes.
4. Validate with the person's Elaichi MCP server (`elaichi__automation__draft__validate` with no `id`; it saves nothing). With no MCP connection: `bun src/cli.ts validate elaichi-drafts` with `ELAICHI_API_TOKEN` set.
5. Ask the person before creating drafts (`elaichi__automation__draft__create`, or `bun src/cli.ts push elaichi-drafts`) and before a dry run.
6. Connected accounts: `bun src/cli.ts connections` (dry run) lists which accounts can move with their credentials and which need a reconnect. It needs `ELAICHI_API_TOKEN`, plus `PIPEDREAM_CLIENT_ID` and `PIPEDREAM_CLIENT_SECRET` (or `PIPEDREAM_API_KEY` and `PIPEDREAM_ORG_ID`), or `--accounts-file <path>`. Read `elaichi-connections/connections-plan.json`. Ask the person before `--apply`: it creates connections.

Hard rules: never publish or enable a workflow. Never print, log or write a token or a credential. Never open, read or `cat` a Pipedream accounts file: it holds live secrets, and reading it puts them in your transcript. Pass its path to `--accounts-file` only. Never invent a redacted secret. Never run the convert command with `--push` for the person: it creates drafts nobody has reviewed.

## If you are changing this repository

- `bun test` and `bunx tsc --strict --noEmit -p .` must pass.
- No runtime dependencies. Bun and Node standard library only.
- The core rule: nothing from the export is dropped without a record. Every step that is not fully converted stays in the draft as a TODO step or a flagged step, and has a report row with `status` `needs_work` or `no_match`, notes, and at least one `todo` kind. Add a test for every new mapping.
- A step is `mapped` only when the Elaichi step does the same job. When in doubt, report `needs_work`.
- `src/catalog.ts` maps Pipedream actions to Elaichi tools. Add an `args` mapper only when both sides' field names were checked, and list the props it reads in `argProps`.
- What is and is not confirmed about the export format is in [FORMAT.md](FORMAT.md). Update it when a real export settles a point.
- `--push` and `push` only call `POST /automation`. Never add a call to publish or enable.
- `connections` only reads Pipedream (`GET /v1/accounts…`, and `POST /oauth/token` for an OAuth client) and calls `GET /connector/{slug}`, `GET /connector/{slug}/oauth-app` and `POST /connection`. No credential value may reach a log line, a file or an error message. `test/connections.test.ts` checks that with a sentinel secret: keep it passing, and extend it for every new output.
