# TSLib - TeamSpeak 3/5 Client Library

> 从 TS3AudioBot 项目提取的独立 TeamSpeak 客户端库

## 简介

TSLib 是一个免费开源的 .NET 库，用于连接 TeamSpeak 3 和 TeamSpeak 5 服务器。支持：

- ✅ 语音客户端连接 (Voice Client)
- ✅ 查询客户端连接 (Query Client)  
- ✅ 发送/接收 Opus 语音
- ✅ 文本消息交互
- ✅ 频道/客户端管理
- ✅ 文件传输
- ✅ 权限管理

## 快速开始

```csharp
using TSLib;
using TSLib.Full;

// 创建客户端
var client = new TsFullClient();

// 生成身份
var identity = TsCrypt.GenerateNewIdentity();

// 连接
var connData = new ConnectionDataFull(
    address: "localhost:9987",
    identity: identity,
    username: "MyBot"
);

await client.Connect(connData);

// 发送消息
await client.SendChannelMessage("Hello!");

// 断开
await client.Disconnect();
client.Dispose();
```

## 项目结构

```
TSLib/
├── src/TSLib/           # 核心库源码
│   ├── Full/             # 语音客户端 (TsFullClient)
│   ├── Query/            # 查询客户端 (TsQueryClient)
│   ├── Audio/            # 音频处理 (Opus)
│   ├── Commands/         # 命令系统
│   ├── Messages/         # 消息类型
│   ├── Helper/           # 工具类
│   └── Scheduler/        # 任务调度
├── docs/                 # API 文档
│   └── TSLib-API-Documentation.md
└── README.md
```

## 依赖 (NuGet)

```xml
<PackageReference Include="NLog" Version="4.7.3" />
<PackageReference Include="Newtonsoft.Json" Version="12.0.3" />
<PackageReference Include="Heijden.Dns.Portable" Version="2.0.19" />
<PackageReference Include="Portable.BouncyCastle" Version="1.8.6.7" />
<PackageReference Include="Splamy.Ed25519.Toolkit" Version="1.0.3" />
<PackageReference Include="System.IO.Pipelines" Version="4.7.2" />
```

## 目标框架

- netcoreapp3.1
- netstandard2.0
- netstandard2.1

## API 文档

详细 API 文档见 [docs/TSLib-API-Documentation.md](docs/TSLib-API-Documentation.md)

## 许可

OSL-3.0 (Open Software License 3.0)

## 致谢

- 原始项目: [TS3AudioBot](https://github.com/Splamy/TS3AudioBot)
- 作者: Splamy, Flakebi
