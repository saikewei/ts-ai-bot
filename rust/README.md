# Rust workspace (upstream)

This directory contains the Rust codebase reused from the upstream
`ReSpeak/tsclientlib` project, which is used as the native backend for this
repository's Node API.

## Upstream

- Project: `tsclientlib`
- Repository: https://github.com/ReSpeak/tsclientlib

Main crates in this directory:

- `rust/tsclientlib`
- `rust/tsproto`
- `rust/utils/*`

## License (upstream)

The upstream Rust project is licensed under:

- Apache License, Version 2.0
- MIT License

See license files at repository root:

- `LICENSE-APACHE`
- `LICENSE-MIT`

Additional vendored dependency license:

- `rust/tsclientlib/vendor/native-tls-0.2.17/LICENSE-APACHE`
- `rust/tsclientlib/vendor/native-tls-0.2.17/LICENSE-MIT`

## Local verification

```bash
cargo check --manifest-path rust/Cargo.toml
```
