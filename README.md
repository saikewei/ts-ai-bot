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

## Docker

项目支持直接打包为 Docker 镜像。镜像内会：

- 在构建阶段编译 Rust 原生模块
- 编译 TypeScript 到 `dist/`
- 运行阶段直接执行 `node dist/main.js`

构建镜像：

```bash
docker build --no-cache -t ts-ai-bot .
```

运行容器：

```bash
docker run --rm \
  -e OPENROUTER_API_KEY="..." \
  -e AZURE_APIKEY="..." \
  -e AZURE_ENDPOINT="https://<region>.tts.speech.microsoft.com" \
  -e TS_ADDRESS="localhost" \
  -e TS_PASSWORD="..." \
  -e TS_CHANNEL="..." \
  -e TS_NICKNAME="ts-audio-llm-demo" \
  ts-ai-bot
```

## 环境变量

运行 `src/main.ts` 时会读取以下环境变量：

| 变量名 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `OPENROUTER_API_KEY` | 是 | 无 | OpenRouter API Key，用于模型推理（`src/llm.ts`）。 |
| `OPENROUTER_HTTP_PROXY` | 否 | 无 | OpenRouter 请求使用的 HTTP 代理地址（如：`http://127.0.0.1:10808`）。未设置时回退读取 `HTTPS_PROXY`/`HTTP_PROXY`。 |
| `AZURE_APIKEY` | 是 | 无 | Azure Speech API Key，用于 TTS（`src/tts.ts`）。 |
| `AZURE_ENDPOINT` | 是 | 无 | Azure Speech Endpoint，示例：`https://<region>.tts.speech.microsoft.com`（代码会自动拼接 `/cognitiveservices/v1`）。 |
| `MODELS_DIR` | 否 | `/app/models` | 模型目录根路径。 |
| `CORE_MELSPEC_MODEL_PATH` | 否 | `${MODELS_DIR}/melspectrogram.onnx` | melspectrogram 模型路径。 |
| `CORE_EMBED_MODEL_PATH` | 否 | `${MODELS_DIR}/embedding_model.onnx` | embedding 模型路径。 |
| `CORE_VAD_MODEL_PATH` | 否 | `${MODELS_DIR}/silero_vad.onnx` | VAD 模型路径。 |
| `WAKEWORD_MODEL_PATH` | 否 | `${MODELS_DIR}/wakeword.onnx` | 唤醒词模型路径。 |
| `WAKEWORD_NAME` | 否 | `wakeword` | 唤醒词名称。 |
| `WAKE_ACK_WAV_PATH` | 否 | `${MODELS_DIR}/wake_ack.wav` | 唤醒后播放“我在”的本地 WAV 路径。 |
| `WAKEWORD_THRESHOLD` | 否 | `0.5` | 唤醒词命中阈值。 |
| `WAKEWORD_VAD_THRESHOLD` | 否 | `0.38` | VAD 语音判定阈值。 |
| `WAKEWORD_VAD_HANGOVER_FRAMES` | 否 | `8` | VAD hangover 帧数（越大越不容易快速从 speech 切回 silence）。 |
| `WAKEWORD_FRAME_LOG` | 否 | `0` | 是否输出逐帧唤醒词日志；`1` 打开，其他值关闭。 |
| `WAKEWORD_PERF_LOG` | 否 | `0` | 是否输出唤醒词处理性能日志；`1` 打开，其他值关闭。 |
| `WAKEWORD_PERF_SUMMARY_MS` | 否 | `5000` | 性能日志汇总周期（毫秒）。 |
| `WAKEWORD_PERF_WARN_QUEUE_DELAY_MS` | 否 | `120` | 单帧排队延迟告警阈值（毫秒）。 |
| `WAKEWORD_PERF_WARN_PENDING` | 否 | `8` | 单说话人待处理任务积压告警阈值。 |
| `SILENCE_TIMEOUT_MS` | 否 | `1500` | 录音中静音超时，超过后自动结束并提交 LLM。 |
| `TS_ADDRESS` | 否 | `localhost` | TeamSpeak 服务器地址。 |
| `TS_PASSWORD` | 否 | 无 | TeamSpeak 服务器密码（有密码时设置）。 |
| `TS_CHANNEL` | 否 | 无 | 连接后要进入的频道。 |
| `TS_NICKNAME` | 否 | `ts-audio-llm-demo` | 机器人昵称。 |
| `LOG_TIMEZONE` | 否 | 系统时区（回退 `UTC`） | 日志时间戳使用的时区。 |

示例（Linux/macOS）：

```bash
export OPENROUTER_API_KEY="..."
export OPENROUTER_HTTP_PROXY="http://127.0.0.1:10808"
export AZURE_APIKEY="..."
export AZURE_ENDPOINT="https://<region>.tts.speech.microsoft.com"
export MODELS_DIR="/app/models"
export WAKEWORD_FRAME_LOG="0"
export WAKEWORD_PERF_LOG="0"
export TS_ADDRESS="localhost"
export TS_PASSWORD="..."
export TS_CHANNEL="..."
export TS_NICKNAME="ts-audio-llm-demo"
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
