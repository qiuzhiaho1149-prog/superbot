# Contributing

Thanks for helping Superbot become a better control plane for DSH.

## Dev setup
```bash
node --test packages/task-engine/test/*.test.js
node --test packages/dsh-superbot/test/*.test.js
```
No build step: the client is plain `React.createElement` loaded by DSH.

## Rules
- Ledger (`packages/dsh-superbot/lib/work-store.js`) is the source of truth; the UI only derives from it.
- Never let an agent accept its own work: evidence must come from a verifier run; human acceptance is a separate surface.
- New acceptance command forms need policy + tests; do not broaden the allowlist silently.
- If you change `packages/task-engine/lib/index.js`, copy it to `packages/dsh-superbot/lib/task-engine.js` (vendored for the standalone tarball); CI checks byte equality.
- Keep `docs/面板设计规范-v1.md` / `docs/上架检查表.md` in sync when behavior changes.

## PR checklist
- Tests pass (`npm test` equivalent above).
- `npm pack --dry-run` includes `lib/task-engine.js`.
- No secrets/tokens in docs, reports, logs.
- For UI changes: attach before/after screenshots (dark + light).
