# Security

Superbot runs agents that can modify code. Defaults are intentionally conservative:

- Manager preset: no shell, read-only filesystem.
- Acceptance commands: fixed-argv allowlist (`node --test`, `npm test`, `pytest`, `cargo test`, `go test ./...`, ...).
- Acceptance runs in a one-time working-tree copy; evidence records `executionMode/sandboxed/isolationMode`.
- Human accept/reject via panel is disabled by default (`httpHumanActions=false`); use the host approval dialog.
- Ledger is single-instance locked and lives outside project workspaces.

Known deployment requirements (D1–D6) and residuals are documented in `docs/Superbot-审核隔离与多层级设计-v1.md`.
Please report vulnerabilities privately via GitHub Security Advisories, not public issues.
