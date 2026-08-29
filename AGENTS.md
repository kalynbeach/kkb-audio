## TypeScript and Wasm tooling

Use Bun 1.4.0 for TypeScript package management, bundling, testing, and runtime tooling where supported. Cargo compiles Rust and Wasm; browser JavaScript and WebAssembly engines execute `AudioWorklet` code. Use Node-only tooling only when a required step cannot run under Bun.

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
