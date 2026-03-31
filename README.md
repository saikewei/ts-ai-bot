# TS-AI-Bot Repository

> Voice AI assistant for TeamSpeak — wake-word activated, LLM-powered, with Azure TTS

---

## Projects

| Project                                                          | Type | Description |
|------------------------------------------------------------------|---|---|
| **TS-AI-Bot**                                                    | Application (.NET 8) | Main bot — wake word, LLM, TTS, TeamSpeak voice |
| **[TSLib](https://github.com/Splamy/TS3AudioBot)**               | Library (.NET Standard 2.0/2.1) | TeamSpeak 3/5 voice + query client library |
| **[NanoWakeWord](https://github.com/samartzidis/NanoWakeWord)** | Library (.NET Standard 2.0) | Local ONNX-based wake-word detection engine |

---

## TS-AI-Bot — At a Glance

TS-AI-Bot connects to a TeamSpeak server as a native voice client. When a user speaks the configured wake word, it:

1. Records the user's spoken query
2. Sends it (as audio + text prompt) to a OpenAI-compatible LLM
3. Reads the reply aloud using Azure Cognitive Services TTS
4. Sends the audio back over TeamSpeak voice

**Key technologies:** .NET 8, TSLib, Azure Cognitive Services Speech, NanoWakeWord (ONNX), Serilog

---

## Repository Structure

```
ts-ai-bot/
├── TS-AI-Bot/                   # Main application
│   ├── Program.cs              # Entry point & pipeline wiring
│   ├── OmniLlmClient.cs        # LLM API client (audio + text)
│   ├── AzureTtsClient.cs        # Azure TTS (streaming PCM)
│   ├── TtsAudioProducer.cs      # Frame-accurate PCM player
│   ├── TsAudioSender.cs         # PCM → TeamSpeak bridge
│   ├── WakeWordDetector.cs      # Porcupine / NanoWakeWord wrapper
│   ├── WakeWordReceiver.cs      # Pipeline node: wake word + capture
│   ├── AppSettings.cs           # YAML config → C# types
│   ├── config.yaml             # Configuration file (gitignored)
│   ├── Dockerfile               # Multi-stage Docker build
│   └── models/                  # ONNX wake-word models
│
├── TSLib/                       # TeamSpeak client library
│   ├── src/TSLib/
│   │   ├── Full/                # TsFullClient (voice protocol)
│   │   ├── Query/               # TsQueryClient (server query)
│   │   ├── Audio/               # Opus encode/decode, audio pipes
│   │   ├── Messages/            # TeamSpeak protocol messages
│   │   ├── Commands/            # Command parser
│   │   ├── Scheduler/           # DedicatedTaskScheduler
│   │   └── Helper/              # TsCrypt, ID utilities
│   └── docs/
│       └── TSLib-API-Documentation.md
│
├── NanoWakeWord/               # Wake-word engine
│   ├── WakeWordRuntime.cs      # ONNX inference pipeline
│   ├── WakeWordUtil.cs
│   └── NanoWakeWord.csproj
│
└── TS-AI-Bot.sln               # Visual Studio / dotnet solution
```

---

## Quick Start

```bash
# Build
dotnet build TS-AI-Bot/TS-AI-Bot.csproj -c Release

# Configure
cp TS-AI-Bot/config.yaml.example TS-AI-Bot/config.yaml
# Edit config.yaml with your TeamSpeak, Azure, and LLM credentials

# Run
dotnet run --project TS-AI-Bot/TS-AI-Bot.csproj -c Release
```


---

## Configuration

All configuration is in `config.yaml`:

```yaml
TeamSpeak:
  Host: "127.0.0.1:9987"
  Username: "TS-AI-Bot"
  ServerPassword: ""

Picovoice:
  UsePico: false
  AccessKey: ""

ModelApi:
  Endpoint: "https://your-api/v1/chat/completions"
  LlmKey: "sk-..."
  Model: "gpt-4o-audio"

AzureTts:
  Endpoint: "https://your-resource.cognitiveservices.azure.com/tts/cognitiveservices/v1"
  Key: "your-azure-key"
  MaxConcurrency: 10
  MaxTextLength: 75
  Speed: 1.0

Texts:
  HelloAudio: "Bot is online!"
  UserPrompts: "Please answer concisely."
  ResponseAudio: ", how can I help?"
```

---

## Supported Features

| Feature | Status | Notes |
|---|---|---|
| Wake word detection | ✅ | Porcupine or NanoWakeWord (local ONNX) |
| Voice recording | ✅ | After wake word, until silence |
| LLM voice query | ✅ | OpenAI-compatible API with `input_audio` support |
| Streaming TTS | ✅ | Azure Cognitive Services, interruptible via `CancellationToken` |
| TeamSpeak voice out | ✅ | Opus-music encoded, stereo |
| Text commands | ✅ | `#stop` interrupts TTS playback |
| Docker deployment | ✅ | Multi-stage build, no .NET SDK in runtime image |
| ARM64 (Linux) | ⚠️ | Not tested; likely requires libopus to be installed separately |

---

## Dependencies

### TS-AI-Bot

| Package | Version | Purpose |
|---|---|---|
| TSLib | (local) | TeamSpeak protocol |
| NanoWakeWord | (local) | Wake-word detection |
| Microsoft.CognitiveServices.Speech | 1.48.2 | Azure TTS |
| Porcupine | 4.0.2 | Picovoice (optional) |
| Serilog | 4.3.1 | Logging |
| Serilog.Sinks.Console | 6.1.1 | Console log output |
| YamlDotNet | 16.3.0 | YAML parsing |

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

See individual project licenses. TSLib is OSL-3.0. TS-AI-Bot and NanoWakeWord are provided as-is.

---

*Maintained: 2026-03-31*
