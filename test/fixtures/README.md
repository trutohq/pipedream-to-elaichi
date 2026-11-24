# Fixtures

These files are hand-built. They are not real Pipedream exports.

Their shape follows what is public as of 24 November 2026:

- Pipedream's [Export Workflows](https://pipedream.com/docs/workflows/export-workflows) page: the zip layout, `manifest.json`, the top-level workflow fields and the `<redacted>` rules.
- Workflow files that Pipedream's GitHub Sync wrote (`namespace`, `runtime`, `uses: key@version`, `props` with `authProvisionId` and `__lv`).
- Other open-source converters (`lang`, `uses: { registry, key, version, code }`).

`github-sync-style.json` uses the GitHub Sync spellings. The others use the export spellings. See `FORMAT.md` at the repo root.
