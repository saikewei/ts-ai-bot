# TS-AI-Bot

> TeamSpeak 语音 AI 助手 — 本地唤醒词检测 + 多模态大模型 + 豆包 TTS 语音合成

---

## 项目概述

TS-AI-Bot 以语音客户端身份连接 TeamSpeak 服务器。用户说出唤醒词后，机器人：

1. **唤醒检测** — 本地 ONNX 模型（NanoWakeWord 或 Porcupine）识别唤醒词
2. **语音采集** — 唤醒后开始录制用户说话，检测静音后结束
3. **多模态推理** — 将音频 + 文本提示发送给 OpenAI 兼容的多模态 LLM（支持 `input_audio`）
4. **流式语音合成** — LLM 回复通过**豆包 TTS**（字节跳动）实时流式合成 PCM 音频
5. **TeamSpeak 语音输出** — PCM 经 Opus-Music 编码后通过 TeamSpeak 语音通道发送

**技术栈：** .NET 8 / C#，TSLib，豆包 TTS（WebSocket 流式），NanoWakeWord（ONNX），Serilog

---

## 目录结构

```
ts-ai-bot/
├── TS-AI-Bot/                        # 主程序 (.NET 8)
│   ├── Program.cs                    # 入口：配置加载 + 启动 + 信号处理
│   ├── TsBot.cs                      # 机器人核心类，组装所有组件
│   ├── OmniLlmClient.cs              # 多模态 LLM 客户端（音频 + 文本，流式输出）
│   ├── DoubaoTtsClient.cs            # 豆包 TTS 客户端（WebSocket 流式合成）
│   ├── TtsAudioProducer.cs           # PCM 帧精确播放器（支持流式合并）
│   ├── TsAudioSender.cs              # PCM → TeamSpeak 语音桥接
│   ├── WakeWordDetector.cs           # NanoWakeWord / Porcupine 封装
│   ├── WakeWordReceiver.cs           # 唤醒词管道节点（检测 + 录音 + 静音检测）
│   ├── AppSettings.cs                # YAML 配置 → C# 类型
│   ├── config.yaml.example           # 配置示例文件
│   └── models/                       # ONNX 唤醒词模型
│
├── TSLib/                            # TeamSpeak 客户端库
│   ├── src/TSLib/
│   │   ├── Full/                     # TsFullClient（语音协议）
│   │   ├── Query/                    # TsQueryClient（服务器查询）
│   │   ├── Audio/                    # Opus 编解码，音频管道
│   │   ├── Messages/                 # TeamSpeak 协议消息
│   │   ├── Commands/                 # 命令解析器
│   │   ├── Scheduler/                # DedicatedTaskScheduler
│   │   └── Helper/                   # TsCrypt，ID 工具
│   └── docs/
│
├── NanoWakeWord/                    # 本地 ONNX 唤醒词引擎
│   ├── WakeWordRuntime.cs           # ONNX 推理管道
│   ├── WakeWordUtil.cs
│   └── NanoWakeWord.csproj
│
├── TS-AI-Bot.sln                    # Visual Studio / dotnet 解决方案
└── TS_AI_Bot.Tests/                 # 单元测试
```

---

## 快速开始

```bash
# 构建
dotnet build TS-AI-Bot/TS-AI-Bot.csproj -c Release

# 配置
cp TS-AI-Bot/config.yaml.example TS-AI-Bot/config.yaml
# 编辑 config.yaml 填入 TeamSpeak、LLM、豆包 TTS 的凭据

# 运行
dotnet run --project TS-AI-Bot/TS-AI-Bot.csproj -c Release
```

---

## 配置说明

所有配置集中在 `config.yaml`：

```yaml
# 唤醒词配置（Porcupine 或 NanoWakeWord）
Picovoice:
  UsePico: false
  AccessKey: "Your key"

# TeamSpeak 服务器
TeamSpeak:
  Host: "127.0.0.1"
  Username: "[bot] bot name"
  ServerPassword: "114514"

# 多模态 LLM（OpenAI 兼容 API，支持 input_audio）
ModelApi:
  LlmKey: "Your key"
  Model: "mimo-v2-omni"
  Endpoint: "https://api.xiaomimimo.com/v1/chat/completions"

# 豆包 TTS（字节跳动，WebSocket 流式）
DoubaoTts:
  AppId: ""
  AccessToken: ""
  Voice: "zh_female_meilinvyou_uranus_bigtts"
  Speed: 1.15

# 文本配置
Texts:
  HelloAudio: "我来啦！"
  UserPrompts: "请和音频中的人对话。如果音频中无法识别正常的人声，请说'我没听清'。音频中的人用什么语言你就用什么语言回复。请不要使用任何markdown语法。"
  ResponseAudio: "，请讲！"
```

---

## 核心架构

```
用户说话
   ↓
WakeWordReceiver（唤醒词检测 + 录音 + 静音检测）
   ↓ 音频 PCM
OmniLlmClient.AskWithRawPcmStreamAsync()（多模态 LLM，流式文本输出）
   ↓ 文本流
DoubaoTtsClient.StreamTtsAsync()（豆包 TTS，WebSocket → PCM 流）
   ↓ PCM 流
TtsAudioProducer.PlayTtsAsync()（帧精确播放，支持流式合并和取消）
   ↓ 音量调节 + Opus 编码
TsAudioSender → TeamSpeak 语音通道
   ↓
用户听到语音回复
```

### 组件职责

| 组件 | 职责 |
|---|---|
| `WakeWordReceiver` | 管道节点：音频包输入，输出唤醒事件 + 录音数据 |
| `OmniLlmClient` | 调用多模态 LLM（同时传音频 + 文本提示），流式接收文本响应 |
| `DoubaoTtsClient` | 豆包 TTS WebSocket 客户端，将文本流实时转为 PCM 音频流 |
| `TtsAudioProducer` | PCM 帧级播放控制，支持流式合并和取消（`CancellationToken`） |
| `TsAudioSender` | 将 PCM 数据经 TSLib 编码后发送到 TeamSpeak 语音通道 |
| `TsBot` | 主编排器：组装各组件，绑定事件，处理业务流程 |

---

## 功能状态

| 功能 | 状态 | 说明 |
|---|---|---|
| 本地唤醒词检测 | ✅ | NanoWakeWord（ONNX）或 Porcupine |
| 语音录制 | ✅ | 唤醒后开始，检测静音结束 |
| 多模态 LLM 语音问答 | ✅ | OpenAI 兼容 API + `input_audio` 支持 |
| 流式 TTS | ✅ | 豆包 TTS，WebSocket 实时流式，可中断 |
| TeamSpeak 语音输出 | ✅ | Opus-Music 编码，立体声 |
| 用户响应音频缓存 | ✅ | 新用户首次唤醒时预合成缓存，加快响应 |
| 文字命令 `#stop` | ✅ | 打断当前 TTS 播放 |
| 日志记录 | ✅ | Serilog + Console 输出 |

---

## 近期更新（Git 历史）

| 提交 | 说明 |
|---|---|
| `f935fda` | 修改唤醒后等待开始录音的逻辑 |
| `8552ea4` | 增加缓存，提高响应速度 |
| `3a8c207` | TTS 无声音 Bug 修复 |
| `e584d9d` | 重构主程序，整合到类中 |
| `838cdb6` | 更新配置示例 |
| `8d16588` | **改用豆包 TTS**，不再使用 Azure |
| `f22c402` | LLM 改为流式输出 |
| `59e08de` | 添加 Apache License 2.0 |

---

## 许可证

Apache License 2.0 — 详见 [LICENSE](LICENSE) 文件

TSLib 为 OSL-3.0。NanoWakeWord 版权归原作者所有。
