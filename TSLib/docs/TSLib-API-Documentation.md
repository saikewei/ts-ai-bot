# TSLib - TeamSpeak 3/5 Client Library

> 独立版 .NET 库，基于 Splamy/TS3AudioBot 的 TSLib
> 用于开发 TeamSpeak 机器人客户端

---

## 1. 项目概述

**TSLib** 是一个免费开源的 TeamSpeak 3 和 TeamSpeak 5 客户端库，支持：
- 语音客户端连接 (Voice Client)
- 查询客户端连接 (Query Client)
- 发送/接收语音
- 文本消息交互
- 频道/客户端管理

### 项目结构

```
TSLib/
├── src/
│   └── TSLib/           # 核心库 (包含 Full + Query)
│       ├── TSLib.csproj
│       ├── Full/         # 语音客户端 (TsFullClient)
│       ├── Query/        # 查询客户端 (TsQueryClient)
│       ├── Audio/        # 音频处理 (Opus 编码/解码)
│       ├── Commands/     # 命令系统
│       ├── Messages/    # 消息类型
│       ├── Helper/       # 工具类
│       └── Scheduler/   # 任务调度
```

---

## 2. 依赖 (NuGet Packages)

```xml
<PackageReference Include="NLog" Version="4.7.3" />
<PackageReference Include="Newtonsoft.Json" Version="12.0.3" />
<PackageReference Include="Heijden.Dns.Portable" Version="2.0.19" />
<PackageReference Include="Portable.BouncyCastle" Version="1.8.6.7" />
<PackageReference Include="Splamy.Ed25519.Toolkit" Version="1.0.3" />
<PackageReference Include="System.IO.Pipelines" Version="4.7.2" />
```

### 目标框架

```xml
<TargetFrameworks>netcoreapp3.1;netstandard2.0;netstandard2.1</TargetFrameworks>
```

---

## 3. 快速开始

### 3.1 安装

```bash
dotnet add package TSLib
```

或手动引用源码项目。

### 3.2 基本使用

```csharp
using TSLib;
using TSLib.Full;

// 创建客户端
var client = new TsFullClient();

// 连接服务器
var identity = TsCrypt.GenerateNewIdentity();
var connData = new ConnectionDataFull(
    address: "localhost:9987",
    identity: identity,
    username: "MyBot",
    defaultChannel: "/Lobby"
);

var result = await client.Connect(connData);
if (!result.Ok)
{
    Console.WriteLine($"连接失败: {result.Error}");
    return;
}

// 发送消息
await client.SendChannelMessage("Hello from bot!");

// 断开连接
await client.Disconnect();
client.Dispose();
```

---

## 4. 核心 API

### 4.1 连接 (Connection)

#### ConnectionData - 基本连接信息

```csharp
// TSLib/ConnectionData.cs
public class ConnectionData
{
    public string Address { get; }      // 服务器地址 (IP:端口)
    public Id LogId { get; }           // 日志标识
}
```

#### ConnectionDataFull - 完整连接信息 (语音客户端)

```csharp
public class ConnectionDataFull : ConnectionData
{
    public IdentityData Identity { get; }              // 身份数据
    public TsVersionSigned VersionSign { get; }        // 客户端版本签名
    public string Username { get; }                   // 用户名
    public Password ServerPassword { get; }            // 服务器密码
    public string DefaultChannel { get; }              // 默认频道
    public Password DefaultChannelPassword { get; }    // 频道密码
}
```

#### Identity - 身份系统

```csharp
// 生成新身份
var identity = TsCrypt.GenerateNewIdentity();

// 提升安全级别 (0-160)
TsCrypt.ImproveSecurity(identity, targetLevel);

// 获取安全级别
int level = TsCrypt.GetSecurityLevel(identity);
```

### 4.2 TsFullClient (语音客户端)

```csharp
// TSLib/Full/TsFullClient.cs
public sealed partial class TsFullClient : TsBaseFunctions
{
    // 属性
    public ClientId ClientId { get; }           // 服务器分配的客户端ID
    public string QuitMessage { get; set; }     // 断开时的消息
    public TsVersionSigned? VersionVersion { get; } // 客户端版本
    public IdentityData? Identity { get; }       // 身份数据
    public Connection Book { get; }              // 服务器数据缓存
    public bool Connected { get; }               // 连接状态
    public bool Connecting { get; }               // 连接中状态
    
    // 事件
    public event EventHandler<DisconnectEventArgs>? OnDisconnected;
    public event EventHandler<CommandError>? OnErrorEvent;
    
    // 方法
    public Task Connect(ConnectionData conData);
    public Task Disconnect();
    public void Dispose();
}
```

### 4.3 TsQueryClient (查询客户端)

```csharp
// TSLib/Query/TsQueryClient.cs
public sealed partial class TsQueryClient : TsBaseFunctions
{
    // 查询客户端不需要身份，适合纯命令操作
    public Task Connect(ConnectionData conData);
}
```

---

## 5. 消息交互 (Text Messages)

### 5.1 发送消息

```csharp
// 私聊消息
await client.SendPrivateMessage("Hello!", clientId);

// 频道消息
await client.SendChannelMessage("Hello channel!");

// 服务器消息
await client.SendServerMessage("Hello server!", serverId: 1);
```

### 5.2 接收消息事件

```csharp
// 使用 Book 监听消息
// 查看 TSLib.Full.Book 获取详细 API
```

---

## 6. 语音功能 (Voice)

### 6.1 发送语音

```csharp
// TSLib/Full/TsFullClient.cs

// 普通语音 - 发送到所在频道
public void SendAudio(in ReadOnlySpan<byte> data, Codec codec)

// 私聊语音 - 指定频道/客户端
public void SendAudioWhisper(
    in ReadOnlySpan<byte> data, 
    Codec codec, 
    IReadOnlyList<ChannelId> channelIds, 
    IReadOnlyList<ClientId> clientIds
)

// 群组私聊语音
public void SendAudioGroupWhisper(
    in ReadOnlySpan<byte> data, 
    Codec codec, 
    GroupWhisperType type, 
    GroupWhisperTarget target, 
    ulong targetId = 0
)
```

### 6.2 音频 Codec

```csharp
public enum Codec : byte
{
    SpeexNarrowband = 0,    // 8kHz 语音
    SpeexWideband = 1,      // 16kHz 语音
    SpeexUltraWideband = 2, // 32kHz 语音
    CeltMono = 3,           // 48kHz 音乐
    OpusVoice = 4,          // 48kHz 优化语音
    OpusMusic = 5,          // 48kHz 立体声音乐
}
```

### 6.3 发送模式

```csharp
public enum TargetSendMode
{
    None,           // 不发送
    Voice,          // 普通语音
    Whisper,        // 私聊语音
    WhisperGroup    // 群组私聊
}

public enum GroupWhisperType
{
    ServerGroup,        // 指定服务器组
    ChannelGroup,       // 指定频道组
    ChannelCommander,   // 频道指挥官
    AllClients          // 所有客户端
}

public enum GroupWhisperTarget
{
    AllChannels,
    CurrentChannel,
    ParentChannel,
    AllParentChannel,
    ChannelFamily,
    CompleteChannelFamily,
    Subchannels,
}
```

### 6.4 音频接口

```csharp
// 音频生产者
public interface IAudioActiveProducer : IAudioStream
{
    IAudioPassiveConsumer? OutStream { get; set; }
    void Start();
    void Stop();
}

// 音频消费者
public interface IAudioPassiveConsumer : IAudioStream
{
    IAudioPassiveConsumer? OutStream { get; set; }
    void Write(Span<byte> data, Meta? meta);
}

// 音频管道
public interface IAudioPipe : IAudioPassiveConsumer, IAudioActiveProducer { }
```

---

## 7. 客户端管理 (Client Management)

### 7.1 获取客户端信息

```csharp
// 获取客户端列表
var clients = await client.ClientList();

// 获取客户端详情
var clientInfo = await client.ClientInfo(clientId);

// 获取客户端数据库信息
var dbInfo = await client.ClientDbInfo(clientDbId);
```

### 7.2 客户端操作

```csharp
// 踢出服务器
await client.KickClientFromServer(clientId);
await client.KickClientFromServer(clientIds);

// 踢出频道
await client.KickClientFromChannel(clientId);

// 封禁
await client.BanClient(clientId, TimeSpan.FromDays(1), "Spam");
await client.BanClient(clientUid, TimeSpan.FromDays(7));

// 改名
await client.ChangeName("NewName");

// 修改描述
await client.ChangeDescription("Description", clientId);

// 移动频道
await client.ClientMove(clientId, targetChannelId);
await client.ClientMove(clientId, targetChannelId, "password");
```

---

## 8. 频道管理 (Channel Management)

### 8.1 频道操作

```csharp
// 获取频道列表
var channels = await client.ChannelList();

// 获取频道信息
var channelInfo = await client.ChannelInfo(channelId);

// 创建频道
await client.ChannelCreate("New Channel");

// 删除频道
await client.ChannelDelete(channelId);

// 修改频道
await client.ChannelEdit(channelId, /* parameters */);

// 订阅频道 (接收事件)
await client.ChannelSubscribe(channelId);
```

---

## 9. 服务器管理 (Server Management)

```csharp
// 获取服务器信息
var serverInfo = await client.ServerInfo();

// 获取服务器版本
var version = await client.Version();

// 获取当前用户信息
var whoami = await client.WhoAmI();

// 服务器公告
await client.SendGlobalMessage("Announcement!");
```

---

## 10. 权限系统 (Permissions)

### 10.1 权限检查

```csharp
// 获取权限
var perms = await client.ClientDbInfo(clientDbId);

// 权限帮助类
TsPermissionHelper.CheckPermissions(response);
```

### 10.2 常用权限 ID

```csharp
// 语音权限
i_client_whisper_power          // 私聊语音
i_client_talk_power             // 发言
b_client_use_channel_commander  // 频道指挥官

// 消息权限
i_client_private_textmessage_power // 私聊消息
b_client_channel_textmessage_send  // 频道消息发送

// 管理权限
i_client_kick_from_server_power   // 踢出服务器
i_client_kick_from_channel_power  // 踢出频道
i_client_ban_power                // 封禁
```

---

## 11. 文件传输 (File Transfer)

```csharp
// 上传文件
await client.FileUpload(path, channelId, data);

// 下载文件
var data = await client.FileDownload(path, channelId);

// 文件列表
var files = await client.FileList(path, channelId);

// 创建目录
await client.FtCreateDirectory(path, channelId);

// 删除文件
await client.FileDelete(path, channelId);
```

---

## 12. 事件系统 (Events)

### 12.1 连接事件

```csharp
client.OnDisconnected += (sender, e) =>
{
    Console.WriteLine($"断开连接: {e.Reason}");
};

// 处理错误事件
client.OnErrorEvent += (sender, error) =>
{
    Console.WriteLine($"错误: {error.Message}");
};
```

### 12.2 DisconnectEventArgs

```csharp
public class DisconnectEventArgs : EventArgs
{
    public Reason Reason { get; }        // 断开原因
    public CommandError? Error { get; }  // 错误信息 (如果有)
}

public enum Reason
{
    UserAction,
    UserOrChannelMoved,
    SubscriptionChanged,
    Timeout,
    KickedFromChannel,
    KickedFromServer,
    Banned,
    ServerStopped,
    LeftServer,
    SocketError = 1000,
}
```

---

## 13. 常用类型 (Common Types)

### 13.1 ID 类型

```csharp
// TeamSpeak 使用多种 ID 类型
ClientId      // ushort  - 当前会话客户端ID
ClientDbId    // ulong   - 数据库客户端ID
ClientUid     // string  - 客户端唯一标识
ChannelId     // ulong   - 频道ID
ServerGroupId // ulong   - 服务器组ID
ChannelGroupId// ulong   - 频道组ID
```

### 13.2 错误处理

```csharp
// 使用 Result 类型处理错误
var result = await client.ClientList();
if (result.Ok)
{
    var clients = result.Value;
}
else
{
    var error = result.Error;
    Console.WriteLine($"错误: {error.Message}");
}
```

---

## 14. 完整示例

### 14.1 简单机器人

```csharp
using System;
using System.Threading.Tasks;
using TSLib;
using TSLib.Full;

class Program
{
    static async Task Main(string[] args)
    {
        var client = new TsFullClient();
        
        // 生成或加载身份
        var identity = TsCrypt.GenerateNewIdentity();
        
        var connData = new ConnectionDataFull(
            address: "127.0.0.1:9987",
            identity: identity,
            username: "Bot",
            defaultChannel: "/Lobby"
        );
        
        var connectResult = await client.Connect(connData);
        if (!connectResult.Ok)
        {
            Console.WriteLine($"连接失败: {connectResult.Error}");
            return;
        }
        
        Console.WriteLine($"已连接! ClientID: {client.ClientId}");
        
        // 发送欢迎消息
        await client.SendChannelMessage("Bot 已上线!");
        
        // 保持运行
        Console.WriteLine("按任意键退出...");
        Console.ReadKey();
        
        // 断开
        await client.Disconnect();
        client.Dispose();
    }
}
```

### 14.2 带重连的机器人

```csharp
public class MyBot
{
    private TsFullClient? client;
    private IdentityData? identity;
    private readonly string address;
    private readonly string username;
    private readonly string channel;
    
    public async Task RunAsync()
    {
        identity = TsCrypt.GenerateNewIdentity();
        
        while (true)
        {
            client = new TsFullClient();
            client.OnDisconnected += OnDisconnected;
            
            var connData = new ConnectionDataFull(
                address, identity, 
                username: username,
                defaultChannel: channel
            );
            
            var result = await client.Connect(connData);
            if (!result.Ok)
            {
                Console.WriteLine($"连接失败，5秒后重试...");
                await Task.Delay(5000);
                continue;
            }
            
            Console.WriteLine("已连接!");
            
            // 等待断开
            await Task.Delay(-1);
        }
    }
    
    private async void OnDisconnected(object? sender, DisconnectEventArgs e)
    {
        Console.WriteLine($"断开: {e.Reason}");
        client?.Dispose();
        
        Console.WriteLine("5秒后重连...");
        await Task.Delay(5000);
        await RunAsync();
    }
}
```

---

## 15. 许可 (License)

**OSL-3.0** (Open Software License 3.0)

---

## 16. 相关资源

- 源码: https://github.com/Splamy/TS3AudioBot
- 原始项目: TSLib (TS3AudioBot 的一部分)

---

*文档生成时间: 2026-03-24*
*基于 TSLib v1.1.0*
