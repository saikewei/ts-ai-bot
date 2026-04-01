using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Serilog;

namespace TS_AI_Bot;

public class DoubaoTtsClient : IDisposable
{
    private readonly string _appId;
    private readonly string _accessToken;
    private readonly string _voice;
    private readonly string _resourceId;
    
    private ClientWebSocket? _webSocket;
    private readonly SemaphoreSlim _sessionLock = new(1, 1); // 保证同一个连接下同一时间只有一个会话进行

    /// <summary>
    /// 初始化豆包 TTS 客户端
    /// </summary>
    /// <param name="appId">火山引擎 App ID</param>
    /// <param name="accessToken">火山引擎 Access Token</param>
    /// <param name="voice">音色 ID (如 zh_female_cancan_mars_bigtts)</param>
    /// <param name="resourceId">模型版本，默认使用 1.0 的 volc.service_type.10029</param>
    public DoubaoTtsClient(string appId, string accessToken, string voice, string resourceId = "seed-tts-2.0")
    {
        _appId = appId;
        _accessToken = accessToken;
        _voice = voice;
        _resourceId = resourceId;
    }
    /// <summary>
    /// 核心接口：接收大模型传来的文本异步流，一边发送给豆包，一边将合成的音频作为异步流返回
    /// </summary>
    public async IAsyncEnumerable<byte[]> StreamTtsAsync(
        IAsyncEnumerable<string> textStream, 
        float speedRate = 1.0f, 
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 豆包 API 要求：同一个 WebSocket 下不支持同时多个 session，必须排队
        await _sessionLock.WaitAsync(cancellationToken);
        try
        {
            // 1. 确保 WebSocket 是健康连接的，断开则重连
            await EnsureConnectedAsync(cancellationToken);
            
            string sessionId = Guid.NewGuid().ToString();

            // 语速转换：豆包要求取值范围 [-50, 100]，100代表2倍速，-50代表0.5倍速
            int rate = (int)((speedRate - 1.0f) * 100);
            rate = Math.Clamp(rate, -50, 100);

            // 2. 发送 StartSession (Event 100)
            var startSessionPayload = new
            {
                @event = 100,
                user = new { uid = "ts_bot_user" },
                req_params = new
                {
                    speaker = _voice,
                    audio_params = new
                    {
                        format = "pcm",
                        sample_rate = 48000,
                        speech_rate = rate
                    }
                }
            };
            
            await SendBinaryMessageAsync(0x14, 0x10, 100, sessionId, JsonSerializer.Serialize(startSessionPayload), cancellationToken);

            var audioChannel = Channel.CreateUnbounded<byte[]>();

            // 3. 开启后台监听任务，不断接收服务器下发的音频和事件
            var receiveTask = Task.Run(async () =>
            {
                try
                {
                    while (!cancellationToken.IsCancellationRequested)
                    {
                        var buffer = await ReceiveFullFrameAsync(cancellationToken);
                        var msg = UnpackMessage(buffer);

                        if (msg.EventId == 352 && msg.AudioData != null) // Event 352: TTSResponse (音频数据)
                        {
                            audioChannel.Writer.TryWrite(msg.AudioData);
                        }
                        else if (msg.EventId is 152 or 153 or 151) // Event 152(Finished), 153(Failed), 151(Canceled)
                        {
                            break; // 会话彻底结束，退出监听循环
                        }
                    }
                }
                catch (Exception ex)
                {
                    audioChannel.Writer.TryComplete(ex);
                }
                finally
                {
                    audioChannel.Writer.TryComplete();
                }
            }, cancellationToken);

            // 4. 开启后台发送任务，消费大模型的文本流，并向服务器推送
            var sendTask = Task.Run(async () =>
            {
                try
                {
                    await foreach (var chunk in textStream.WithCancellation(cancellationToken))
                    {
                        Log.Debug("Get Text: " + chunk);
                        if (string.IsNullOrWhiteSpace(chunk)) continue;

                        // 发送 TaskRequest (Event 200)，推送文本分块
                        var taskPayload = new { @event = 200, req_params = new { text = chunk } };
                        await SendBinaryMessageAsync(0x14, 0x10, 200, sessionId, JsonSerializer.Serialize(taskPayload), cancellationToken);
                    }

                    await SendBinaryMessageAsync(0x14, 0x10, 102, sessionId, "{\"event\":102}", cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    try { await SendBinaryMessageAsync(0x14, 0x10, 101, sessionId, "{\"event\":101}", default); } catch { /* 忽略重置期间的网络异常 */ }
                }
            }, cancellationToken);

            // 5. 将接收到的音频流实时吐出给外部播放器
            await foreach (var audioBytes in audioChannel.Reader.ReadAllAsync(cancellationToken))
            {
                yield return audioBytes;
            }

            await Task.WhenAll(receiveTask, sendTask);
        }
        finally
        {
            _sessionLock.Release();
        }
    }
    public async Task<byte[]> SpeakTextAsync(string text, float speedRate = 1.0f, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return Array.Empty<byte>(); // 推荐使用 Array.Empty<byte>()
        }

        // 复用同一个 WebSocket 链接，确保线程安全
        await _sessionLock.WaitAsync(cancellationToken);
        try
        {
            // 确保底层 WebSocket 连接是活着的
            await EnsureConnectedAsync(cancellationToken);
            
            string sessionId = Guid.NewGuid().ToString();

            int rate = (int)((speedRate - 1.0f) * 100);
            rate = Math.Clamp(rate, -50, 100);

            // 1. 发送 StartSession (Event 100)
            var startSessionPayload = new
            {
                @event = 100, 
                user = new { uid = "ts_bot_user" },
                req_params = new
                {
                    speaker = _voice,
                    audio_params = new
                    {
                        format = "pcm",
                        sample_rate = 48000,
                        speech_rate = rate
                    }
                }
            };
            await SendBinaryMessageAsync(0x14, 0x10, 100, sessionId, JsonSerializer.Serialize(startSessionPayload), cancellationToken);

            // 2. 发送全量文本 TaskRequest (Event 200)
            var taskPayload = new { @event = 200, req_params = new { text } };
            await SendBinaryMessageAsync(0x14, 0x10, 200, sessionId, JsonSerializer.Serialize(taskPayload), cancellationToken);

            // 3. 立刻告诉服务器：我发完了，准备接收 FinishSession (Event 102)
            await SendBinaryMessageAsync(0x14, 0x10, 102, sessionId, "{\"event\":102}", cancellationToken);

            // 4. 循环接收服务器返回的音频碎片，并拼装成完整的字节数组
            using var ms = new MemoryStream();
            while (!cancellationToken.IsCancellationRequested)
            {
                var buffer = await ReceiveFullFrameAsync(cancellationToken);
                var msg = UnpackMessage(buffer);

                if (msg.EventId == 352 && msg.AudioData != null) // 收到音频帧
                {
                    ms.Write(msg.AudioData, 0, msg.AudioData.Length);
                }
                else if (msg.EventId is 152 or 153 or 151) // 会话结束、失败或被取消
                {
                    break;
                }
            }

            return ms.ToArray();
        }
        finally
        {
            _sessionLock.Release();
        }
    }
    /// <summary>
    /// 确保 WebSocket 已连接，实现断线自动重连
    /// </summary>
    private async Task EnsureConnectedAsync(CancellationToken ct)
    {
        if (_webSocket is { State: WebSocketState.Open })
            return;

        _webSocket?.Dispose();
        _webSocket = new ClientWebSocket();
        _webSocket.Options.SetRequestHeader("X-Api-App-Key", _appId);
        _webSocket.Options.SetRequestHeader("X-Api-Access-Key", _accessToken);
        _webSocket.Options.SetRequestHeader("X-Api-Resource-Id", _resourceId);
        _webSocket.Options.SetRequestHeader("X-Api-Connect-Id", Guid.NewGuid().ToString());

        await _webSocket.ConnectAsync(new Uri("wss://openspeech.bytedance.com/api/v3/tts/bidirection"), ct);

        // 建立底层连接：发送 StartConnection (Event 1)
        await SendBinaryMessageAsync(0x14, 0x10, 1, null, "{}", ct);

        // 验证建连：期待收到 ConnectionStarted (Event 50)
        var responseBytes = await ReceiveFullFrameAsync(ct);
        var res = UnpackMessage(responseBytes);
        if (res.EventId != 50)
        {
            throw new Exception($"连接豆包 TTS 失败。预期 Event: 50，实际收到: {res.EventId}，内容: {res.JsonPayload}");
        }
    }

    #region 豆包专属二进制帧协议封包/解包逻辑

    private async Task SendBinaryMessageAsync(byte messageTypeFlags, byte serialization, int eventId, string? sessionId, string payloadJson, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        // 4 字节 Header
        ms.WriteByte(0x11);             // Protocol v1, Header size 4
        ms.WriteByte(messageTypeFlags); // Message type & specific flags
        ms.WriteByte(serialization);    // Serialization method (0x10=JSON, 0x00=Raw)
        ms.WriteByte(0x00);             // Reserved & Compression

        WriteInt32BigEndian(ms, eventId);

        if (sessionId != null)
        {
            byte[] sBytes = Encoding.UTF8.GetBytes(sessionId);
            WriteInt32BigEndian(ms, sBytes.Length);
            ms.Write(sBytes);
        }

        byte[] pBytes = Encoding.UTF8.GetBytes(payloadJson);
        WriteInt32BigEndian(ms, pBytes.Length);
        ms.Write(pBytes);

        if (_webSocket == null) throw new InvalidOperationException("WebSocket 尚未初始化。");
        await _webSocket.SendAsync(new ArraySegment<byte>(ms.ToArray()), WebSocketMessageType.Binary, true, ct);
    }

    private async Task<byte[]> ReceiveFullFrameAsync(CancellationToken ct)
    {
        if (_webSocket == null) throw new InvalidOperationException("WebSocket 尚未初始化。");
        using var ms = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new Exception("豆包 WebSocket 服务端主动断开了连接。");

            ms.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) break;
        }
        return ms.ToArray();
    }

    private (int EventId, byte[]? AudioData, string? JsonPayload) UnpackMessage(byte[] data)
    {
        if (data.Length < 8) return (-1, null, null);

        byte msgType = data[1];
        byte serialization = data[2];

        // 处理错误帧 (0b11110000 -> 0xF0)
        if ((msgType & 0xF0) == 0xF0)
        {
            int errCode = ReadInt32BigEndian(data, 4);
            string errJson = Encoding.UTF8.GetString(data, 8, data.Length - 8);
            throw new Exception($"豆包 TTS 异常! 错误码: {errCode}, 详情: {errJson}");
        }

        // 判断是否携带 Event ID (specific flags 包含 0x04)
        bool hasEvent = (msgType & 0x0F) == 0x04;
        if (!hasEvent) return (-1, null, null);

        int eventId = ReadInt32BigEndian(data, 4);

        // 结构分析：Header[4] -> EventId[4] -> ID_Len[4] -> ID[Len] -> Payload_Len[4] -> Payload[Len]
        int idLen = ReadInt32BigEndian(data, 8);
        int payloadLenIndex = 12 + idLen;
        if (payloadLenIndex + 4 > data.Length) return (eventId, null, null);

        int payloadLen = ReadInt32BigEndian(data, payloadLenIndex);
        int payloadIndex = payloadLenIndex + 4;

        if (payloadIndex + payloadLen > data.Length) payloadLen = data.Length - payloadIndex;

        // Serialization = 0x00 表示 Raw 二进制音频数据
        if (serialization == 0x00)
        {
            byte[] audio = new byte[payloadLen];
            Buffer.BlockCopy(data, payloadIndex, audio, 0, payloadLen);
            return (eventId, audio, null);
        }
        
        // 否则视为 JSON 信息反馈（如 SessionStarted, TTSSentenceEnd 等）
        string json = Encoding.UTF8.GetString(data, payloadIndex, payloadLen);
        return (eventId, null, json);
    }

    // 豆包 API 强制要求协议中所有 32 位整型全部采用大端字节序 (Big Endian)
    private static void WriteInt32BigEndian(MemoryStream ms, int value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
        ms.Write(bytes, 0, 4);
    }

    private static int ReadInt32BigEndian(byte[] data, int offset)
    {
        byte[] bytes = new byte[4];
        Buffer.BlockCopy(data, offset, bytes, 0, 4);
        if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
        return BitConverter.ToInt32(bytes, 0);
    }

    #endregion

    public void Dispose()
    {
        _sessionLock.Dispose();
        _webSocket?.Dispose();
    }
}