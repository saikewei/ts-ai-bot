# tsclientlib Node native addon (napi-rs)

This folder contains the Rust + JS bridge layer used by the Node-first repository.

## Build from repo root

```bash
npm run build:native
npm run prepare:native
```

Or run directly in this folder:

```bash
cargo build --manifest-path Cargo.toml
node scripts/prepare-native.js
```

## Structure

- `src/lib.rs`: napi-rs native implementation
- `index.js`: JS wrapper (`EventEmitter` + event normalization)
- `index.d.ts`: Type declarations
- `examples/`: low-level addon examples
