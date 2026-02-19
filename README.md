# TS AI Bot (TeamSpeak)

这是一个以 **TypeScript AI Bot** 为核心的仓库。  
主要开发对象是根目录下的 TS 业务代码，Rust 部分作为 Node 原生能力的底层实现。

## 目标

- 使用 TypeScript 开发和迭代 AI Bot 逻辑
- 通过 Node 原生模块调用 TeamSpeak 客户端能力
- 保持 Rust 依赖层稳定，尽量减少对上游结构的侵入式修改

## 目录结构

```text
.
├─ package.json
├─ index.js
├─ index.d.ts
├─ src/                         # TS AI Bot 主代码
├─ examples/                    # TS 示例
├─ native/tsclientlib-node/     # Node 原生模块（napi-rs）
└─ rust/                        # 上游 Rust 工作区（被本项目复用）
```

## 开发流程

1. 构建原生模块

```bash
npm run build:native
npm run prepare:native
```

2. 运行 TS 开发入口

```bash
npm run dev
```

## Rust 相关

Rust crate 位于 `rust/`，主要作为 Node API 的底层实现。  
常用检查命令：

```bash
cargo check --manifest-path rust/Cargo.toml
```

## 第三方项目归属说明

本仓库复用了上游 `ReSpeak/tsclientlib` 的 Rust 实现：

- Upstream project: `ReSpeak/tsclientlib`
- Upstream repository: https://github.com/ReSpeak/tsclientlib
- Upstream code in this repo: `rust/`
- 用途：作为 `native/tsclientlib-node` 的底层依赖

更多上游信息见 `rust/README.md`。

## 许可证

本仓库采用双许可证：

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT License (`LICENSE-MIT`)

同时包含第三方组件许可证：

- 上游 `tsclientlib` Rust workspace（license: `MIT OR Apache-2.0`）
- vendored `native-tls`：
  - `rust/tsclientlib/vendor/native-tls-0.2.17/LICENSE-APACHE`
  - `rust/tsclientlib/vendor/native-tls-0.2.17/LICENSE-MIT`
