# Fixtures

These files are hand-built. They are not real Pipedream exports.

Their shape follows what is public as of 24 November 2026:

- Pipedream's [Export Workflows](https://pipedream.com/docs/workflows/export-workflows) page: the zip layout, `manifest.json`, the top-level workflow fields and the `<redacted>` rules.
- Workflow files that Pipedream's GitHub Sync wrote (`namespace`, `runtime`, `uses: key@version`, `props` with `authProvisionId` and `__lv`).
- Other open-source converters (`lang`, `uses: { registry, key, version, code }`).

`github-sync-style.json` uses the GitHub Sync spellings. The others use the export spellings. See `FORMAT.md` at the repo root.

`connections/accounts.json` is a hand-built Pipedream list-accounts answer (`GET /v1/accounts?include_credentials=true`, shape from https://pipedream.com/docs/connect/api-reference/list-accounts and https://pipedream.com/docs/rest-api/api-reference/accounts/get-account, checked 26 November 2026). Every credential value starts with `SENTINEL_SECRET` so tests can prove no value is printed or written.
