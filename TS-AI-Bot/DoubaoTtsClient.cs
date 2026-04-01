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
    
    // Lock to ensure we don't overlap TTS audio playing/requesting
    private readonly SemaphoreSlim _sessionLock = new(1, 1); 

    public DoubaoTtsClient(string appId, string accessToken, string voice, string resourceId = "seed-tts-2.0")
    {
        _appId = appId;
        _accessToken = accessToken;
        _voice = voice;
        _resourceId = resourceId;
    }

    /// <summary>
    /// Stream interface: Consume text chunks and yield audio chunks in real-time.
    /// Creates a fresh WebSocket connection for each request.
    /// </summary>
    public async IAsyncEnumerable<byte[]> StreamTtsAsync(
        IAsyncEnumerable<string> textStream, 
        float speedRate = 1.0f, 
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await _sessionLock.WaitAsync(cancellationToken);
        try
        {
            // Create a fresh connection for this session
            using var ws = await ConnectWebSocketAsync(cancellationToken);
            string sessionId = Guid.NewGuid().ToString();

            int rate = (int)((speedRate - 1.0f) * 100);
            rate = Math.Clamp(rate, -50, 100);
            var wsSafe = ws;

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
            
            await SendBinaryMessageAsync(ws, 0x14, 0x10, 100, sessionId, JsonSerializer.Serialize(startSessionPayload), cancellationToken);

            var audioChannel = Channel.CreateUnbounded<byte[]>();

            // Background task: Receive audio frames and events
            var receiveTask = Task.Run(async () =>
            {
                try
                {
                    while (!cancellationToken.IsCancellationRequested)
                    {
                        var buffer = await ReceiveFullFrameAsync(wsSafe, cancellationToken);
                        var msg = UnpackMessage(buffer);

                        if (msg.EventId == 352 && msg.AudioData != null) 
                        {
                            Log.Debug("Audio frame received, length: {Length} bytes", msg.AudioData.Length);
                            audioChannel.Writer.TryWrite(msg.AudioData);
                        }
                        else if (msg.EventId == 152) 
                        {
                            Log.Debug("TTS session closed normally (Event 152)");
                            break; 
                        }
                        else if (msg.EventId == 153)
                        {
                            Log.Error("TTS Error (Event 153): {Payload}", msg.JsonPayload);
                            break;
                        }
                        else if (msg.EventId == 151)
                        {
                            Log.Warning("TTS session canceled (Event 151)");
                            break;
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log.Error(ex, "Exception in TTS receive task");
                    audioChannel.Writer.TryComplete(ex);
                }
                finally
                {
                    audioChannel.Writer.TryComplete();
                }
            }, cancellationToken);

            // Background task: Send text chunks
            var sendTask = Task.Run(async () =>
            {
                try
                {
                    bool hasSentText = false;
                    await foreach (var chunk in textStream.WithCancellation(cancellationToken))
                    {
                        if (string.IsNullOrWhiteSpace(chunk)) continue;
                        hasSentText = true;

                        Log.Debug("Sending text chunk to Doubao: {Text}", chunk);
                        var taskPayload = new { @event = 200, req_params = new { text = chunk } };
                        await SendBinaryMessageAsync(wsSafe, 0x14, 0x10, 200, sessionId, JsonSerializer.Serialize(taskPayload), cancellationToken);
                    }

                    // Flush buffer to prevent text swallowing
                    if (hasSentText)
                    {
                        Log.Debug("Sending flush punctuation (.) to prevent text swallowing");
                        var flushPayload = new { @event = 200, req_params = new { text = "。" } };
                        await SendBinaryMessageAsync(wsSafe, 0x14, 0x10, 200, sessionId, JsonSerializer.Serialize(flushPayload), cancellationToken);
                    }

                    Log.Debug("Text stream finished, sending Event 102 (FinishSession)");
                    await SendBinaryMessageAsync(wsSafe, 0x14, 0x10, 102, sessionId, "{\"event\":102}", cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    Log.Information("Text stream canceled, sending Event 101 (CancelSession)");
                    await SendBinaryMessageAsync(wsSafe, 0x14, 0x10, 101, sessionId, "{\"event\":101}", CancellationToken.None); 
                }
                catch (Exception ex)
                {
                    Log.Error(ex, "Exception occurred while sending stream text");
                    audioChannel.Writer.TryComplete(ex); 
                }
            }, cancellationToken);

            await foreach (var audioBytes in audioChannel.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                yield return audioBytes;
            }

            await Task.WhenAll(receiveTask, sendTask).ConfigureAwait(false);

            // Gracefully close WebSocket
            if (ws.State == WebSocketState.Open)
            {
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Session complete", default);
            }
        }
        finally
        {
            _sessionLock.Release();
        }
    }

    /// <summary>
    /// Single-shot interface: Synthesize complete text.
    /// Creates a fresh WebSocket connection for each request.
    /// </summary>
    public async Task<byte[]> SpeakTextAsync(string text, float speedRate = 1.0f, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return Array.Empty<byte>(); 
        }

        await _sessionLock.WaitAsync(cancellationToken);
        try
        {
            using var ws = await ConnectWebSocketAsync(cancellationToken);
            string sessionId = Guid.NewGuid().ToString();

            int rate = (int)((speedRate - 1.0f) * 100);
            rate = Math.Clamp(rate, -50, 100);

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
            await SendBinaryMessageAsync(ws, 0x14, 0x10, 100, sessionId, JsonSerializer.Serialize(startSessionPayload), cancellationToken);

            var taskPayload = new { @event = 200, req_params = new { text } };
            await SendBinaryMessageAsync(ws, 0x14, 0x10, 200, sessionId, JsonSerializer.Serialize(taskPayload), cancellationToken);

            await SendBinaryMessageAsync(ws, 0x14, 0x10, 102, sessionId, "{\"event\":102}", cancellationToken);

            using var ms = new MemoryStream();
            while (!cancellationToken.IsCancellationRequested)
            {
                var buffer = await ReceiveFullFrameAsync(ws, cancellationToken);
                var msg = UnpackMessage(buffer);

                if (msg.EventId == 352 && msg.AudioData != null) 
                {
                    ms.Write(msg.AudioData, 0, msg.AudioData.Length);
                }
                else if (msg.EventId is 152 or 153 or 151) 
                {
                    if (msg.EventId == 153) Log.Error("TTS Error (Event 153): {Payload}", msg.JsonPayload);
                    break;
                }
            }

            if (ws.State == WebSocketState.Open)
            {
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Session complete", default);
            }

            return ms.ToArray();
        }
        finally
        {
            _sessionLock.Release();
        }
    }

    /// <summary>
    /// Establish a new WebSocket connection and perform initial handshake.
    /// </summary>
    private async Task<ClientWebSocket> ConnectWebSocketAsync(CancellationToken ct)
    {
        var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("X-Api-App-Key", _appId);
        ws.Options.SetRequestHeader("X-Api-Access-Key", _accessToken);
        ws.Options.SetRequestHeader("X-Api-Resource-Id", _resourceId);
        ws.Options.SetRequestHeader("X-Api-Connect-Id", Guid.NewGuid().ToString());

        await ws.ConnectAsync(new Uri("wss://openspeech.bytedance.com/api/v3/tts/bidirection"), ct);

        await SendBinaryMessageAsync(ws, 0x14, 0x10, 1, null, "{\"event\":1}", ct);

        var responseBytes = await ReceiveFullFrameAsync(ws, ct);
        var res = UnpackMessage(responseBytes);
        if (res.EventId != 50)
        {
            ws.Dispose();
            throw new Exception($"Failed to connect to Doubao TTS. Expected Event: 50, Actual: {res.EventId}, Payload: {res.JsonPayload}");
        }

        return ws;
    }

    #region Binary Frame Protocol Methods

    private async Task SendBinaryMessageAsync(ClientWebSocket ws, byte messageTypeFlags, byte serialization, int eventId, string? sessionId, string payloadJson, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        ms.WriteByte(0x11);             
        ms.WriteByte(messageTypeFlags); 
        ms.WriteByte(serialization);    
        ms.WriteByte(0x00);             

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

        await ws.SendAsync(new ArraySegment<byte>(ms.ToArray()), WebSocketMessageType.Binary, true, ct);
    }

    private async Task<byte[]> ReceiveFullFrameAsync(ClientWebSocket ws, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new Exception("Doubao WebSocket server closed the connection.");

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

        if ((msgType & 0xF0) == 0xF0)
        {
            int errCode = ReadInt32BigEndian(data, 4);
            string errJson = Encoding.UTF8.GetString(data, 8, data.Length - 8);
            throw new Exception($"Doubao TTS Exception! Code: {errCode}, Details: {errJson}");
        }

        bool hasEvent = (msgType & 0x0F) == 0x04;
        if (!hasEvent) return (-1, null, null);

        int eventId = ReadInt32BigEndian(data, 4);
        int idLen = ReadInt32BigEndian(data, 8);
        int payloadLenIndex = 12 + idLen;
        
        if (payloadLenIndex + 4 > data.Length) return (eventId, null, null);

        int payloadLen = ReadInt32BigEndian(data, payloadLenIndex);
        int payloadIndex = payloadLenIndex + 4;

        if (payloadIndex + payloadLen > data.Length) payloadLen = data.Length - payloadIndex;

        if (serialization == 0x00)
        {
            byte[] audio = new byte[payloadLen];
            Buffer.BlockCopy(data, payloadIndex, audio, 0, payloadLen);
            return (eventId, audio, null);
        }
        
        string json = Encoding.UTF8.GetString(data, payloadIndex, payloadLen);
        return (eventId, null, json);
    }

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
        // Socket is now managed locally per-request, no need to dispose here.
    }
}