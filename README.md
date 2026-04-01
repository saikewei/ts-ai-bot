# TS-AI-Bot

> TeamSpeak Voice AI Assistant — Local wake-word detection + Multimodal LLM + Doubao TTS

---

## Overview

TS-AI-Bot connects to a TeamSpeak server as a native voice client. When a user speaks the configured wake word, it:

1. **Wake Detection** — Local ONNX model (NanoWakeWord or Porcupine) detects the wake word
2. **Voice Recording** — Starts recording after wake word; stops on silence detection
3. **Multimodal Inference** — Sends audio + text prompt to an OpenAI-compatible multimodal LLM (with `input_audio` support)
4. **Streaming TTS** — LLM response is streamed in real-time to **Doubao TTS** (ByteDance) for PCM audio synthesis
5. **TeamSpeak Voice Output** — PCM is Opus-Music encoded and sent via TeamSpeak voice channel

**Tech stack:** .NET 8 / C#, TSLib, Doubao TTS (WebSocket streaming), NanoWakeWord (ONNX), Serilog

---

## Repository Structure

```
ts-ai-bot/
├── TS-AI-Bot/                        # Main application (.NET 8)
│   ├── Program.cs                    # Entry: config loading + startup + signal handling
│   ├── TsBot.cs                      # Core bot class, wires all components together
│   ├── OmniLlmClient.cs              # Multimodal LLM client (audio + text, streaming output)
│   ├── DoubaoTtsClient.cs            # Doubao TTS client (WebSocket streaming)
│   ├── TtsAudioProducer.cs           # Frame-accurate PCM player (streaming merge)
│   ├── TsAudioSender.cs              # PCM → TeamSpeak voice bridge
│   ├── WakeWordDetector.cs           # NanoWakeWord / Porcupine wrapper
│   ├── WakeWordReceiver.cs           # Wake word pipeline node (detect + record + VAD)
│   ├── AppSettings.cs                # YAML config → C# types
│   ├── config.yaml.example           # Sample config file
│   └── models/                       # ONNX wake-word models
│
├── TSLib/                            # TeamSpeak client library
│   ├── src/TSLib/
│   │   ├── Full/                     # TsFullClient (voice protocol)
│   │   ├── Query/                    # TsQueryClient (server query)
│   │   ├── Audio/                    # Opus encode/decode, audio pipes
│   │   ├── Messages/                 # TeamSpeak protocol messages
│   │   ├── Commands/                 # Command parser
│   │   ├── Scheduler/                # DedicatedTaskScheduler
│   │   └── Helper/                   # TsCrypt, ID utilities
│   └── docs/
│
├── NanoWakeWord/                    # Local ONNX wake-word engine
│   ├── WakeWordRuntime.cs           # ONNX inference pipeline
│   ├── WakeWordUtil.cs
│   └── NanoWakeWord.csproj
│
├── TS-AI-Bot.sln                    # Visual Studio / dotnet solution
└── TS_AI_Bot.Tests/                 # Unit tests
```

---

## Quick Start

```bash
# Build
dotnet build TS-AI-Bot/TS-AI-Bot.csproj -c Release

# Configure
cp TS-AI-Bot/config.yaml.example TS-AI-Bot/config.yaml
# Edit config.yaml with your TeamSpeak, LLM, and Doubao TTS credentials

# Run
dotnet run --project TS-AI-Bot/TS-AI-Bot.csproj -c Release
```

---

## Configuration

All configuration is in `config.yaml`:

```yaml
# Wake word (Porcupine or NanoWakeWord)
Picovoice:
  UsePico: false
  AccessKey: "Your key"

# TeamSpeak server
TeamSpeak:
  Host: "127.0.0.1"
  Username: "[bot] bot name"
  ServerPassword: "114514"

# Multimodal LLM (OpenAI-compatible API, must support input_audio)
ModelApi:
  LlmKey: "Your key"
  Model: "mimo-v2-omni"
  Endpoint: "https://api.xiaomimimo.com/v1/chat/completions"

# Doubao TTS (ByteDance, WebSocket streaming)
DoubaoTts:
  AppId: ""
  AccessToken: ""
  Voice: "zh_female_meilinvyou_uranus_bigtts"
  Speed: 1.15

# Text configuration
Texts:
  HelloAudio: "我来啦！"
  UserPrompts: "Please converse with the person in the audio. If you cannot identify a normal human voice, say 'I didn't catch that'. Reply in the same language as the audio. Do not use any markdown formatting."
  ResponseAudio: "，请讲！"
```

---

## Architecture

```
User speaks
   ↓
WakeWordReceiver (wake detection + recording + silence VAD)
   ↓ PCM audio
OmniLlmClient.AskWithRawPcmStreamAsync() (multimodal LLM, streaming text)
   ↓ text stream
DoubaoTtsClient.StreamTtsAsync() (Doubao TTS, WebSocket → PCM stream)
   ↓ PCM stream
TtsAudioProducer.PlayTtsAsync() (frame-accurate playback, stream merge + cancel)
   ↓ volume + Opus encoding
TsAudioSender → TeamSpeak voice channel
   ↓
User hears voice reply
```

### Component Responsibilities

| Component | Responsibility |
|---|---|
| `WakeWordReceiver` | Pipeline node: audio packets in, wake events + recording data out |
| `OmniLlmClient` | Calls multimodal LLM (audio + text prompt), streams text response |
| `DoubaoTtsClient` | Doubao TTS WebSocket client, converts text stream to real-time PCM audio |
| `TtsAudioProducer` | PCM frame-level playback control, supports stream merge and cancellation |
| `TsAudioSender` | Sends PCM via TSLib → TeamSpeak voice channel |
| `TsBot` | Main orchestrator: wires components, binds events, handles business logic |

---

## Feature Status

| Feature | Status | Notes |
|---|---|---|
| Local wake-word detection | ✅ | NanoWakeWord (ONNX) or Porcupine |
| Voice recording | ✅ | Starts after wake, ends on silence |
| Multimodal LLM voice QA | ✅ | OpenAI-compatible API + `input_audio` |
| Streaming TTS | ✅ | Doubao TTS, WebSocket real-time, interruptible |
| TeamSpeak voice output | ✅ | Opus-Music encoded, stereo |
| User response audio cache | ✅ | Pre-synthesized on first wake to speed up response |
| Text command `#stop` | ✅ | Interrupts current TTS playback |
| Logging | ✅ | Serilog + Console output |

---

## Recent Commits

| Commit | Description |
|---|---|
| `f935fda` | Fix logic for waiting after wake before recording |
| `8552ea4` | Add caching to improve response speed |
| `3a8c207` | Fix TTS no-audio bug |
| `e584d9d` | Refactor main program into a class |
| `838cdb6` | Update config example |
| `8d16588` | **Switch to Doubao TTS**, remove Azure |
| `f22c402` | LLM output changed to streaming |
| `59e08de` | Add Apache License 2.0 |

---

## Dependencies

### TS-AI-Bot

| Package | Version | Purpose |
|---|---|---|
| TSLib | (local) | TeamSpeak protocol |
| NanoWakeWord | (local) | Wake-word detection |
| Microsoft.CognitiveServices.Speech | 1.48.2 | — (legacy dep) |
| Porcupine | 4.0.2 | Picovoice (optional) |
| Serilog | 4.3.1 | Logging |
| Serilog.Sinks.Console | 6.1.1 | Console logging |
| YamlDotNet | 16.3.0 | YAML config parsing |

### TSLib

| Package | Version |
|---|---|
| NLog | 4.7.3 |
| Newtonsoft.Json | 12.0.3 |
| Heijden.Dns.Portable | 2.0.19 |
| Portable.BouncyCastle | 1.8.6.7 |
| Splamy.Ed25519.Toolkit | 1.0.3 |
| System.IO.Pipelines | 4.7.2 |

---

## License

Apache License 2.0 — see [LICENSE](LICENSE)

TSLib is OSL-3.0. NanoWakeWord copyright by original authors.
