using Serilog;
using TSLib;
using TSLib.Audio;
using TSLib.Full;
using TSLib.Messages;
using TSLib.Scheduler;
using System.Collections.Concurrent;

namespace TS_AI_Bot;

public class TsBot : IAsyncDisposable
{
    private readonly AppSettings _config;
    
    // 核心组件
    private readonly DedicatedTaskScheduler _scheduler;
    private readonly TsFullClient _client;
    
    // 音频输入管道
    private readonly WakeWordReceiver _wakeWordReceiver;
    
    // 音频输出管道
    private readonly TtsAudioProducer _ttsAudioProducer;

    // AI 客户端
    private readonly DoubaoTtsClient _doubaoTtsClient;
    private readonly OmniLlmClient _llmClient;

    // 状态与缓存
    private CancellationTokenSource? _ttsCts;
    private readonly byte[] _beepAudio;
    private byte[]? _helloAudio;
    private readonly ConcurrentDictionary<ushort, byte[]> _responseAudioCache;

    public TsBot(AppSettings config)
    {
        _config = config;
        
        // 1. 初始化 TS 客户端与调度器
        _scheduler = new DedicatedTaskScheduler(new TSLib.Helper.Id(1));
        _client = new TsFullClient(_scheduler);

        // 2. 初始化 AI 客户端
        _doubaoTtsClient = new DoubaoTtsClient(_config.DoubaoTts.AppId, _config.DoubaoTts.AccessToken, _config.DoubaoTts.Voice);
        _llmClient = new OmniLlmClient(_config.ModelApi.Endpoint, _config.ModelApi.LlmKey, _config.ModelApi.Model, _config.ModelApi.MaxContextTurns);

        // 3. 初始化音频组件
        var packetReader = new AudioPacketReader();
        var decoderPipe = new DecoderPipe();
        _wakeWordReceiver = new WakeWordReceiver(_config.Picovoice.UsePico ? _config.Picovoice.AccessKey : null);
        
        _ttsAudioProducer = new TtsAudioProducer();
        var volumePipe = new VolumePipe { Volume = 0.45f };
        var encoderPipe = new EncoderPipe(Codec.OpusMusic);
        var tsAudioSender = new TsAudioSender(_client);

        // 生成缓存音频
        _beepAudio = TtsAudioProducer.GenerateBeepPcm();
        _responseAudioCache = new ConcurrentDictionary<ushort, byte[]>();

        // 4. 组装音频管道
        _client.OutStream = packetReader;
        packetReader.OutStream = decoderPipe;
        decoderPipe.OutStream = _wakeWordReceiver;

        _ttsAudioProducer.OutStream = volumePipe;
        volumePipe.OutStream = encoderPipe;
        encoderPipe.OutStream = tsAudioSender;

        // 5. 绑定事件
        _wakeWordReceiver.OnAudioRecorded += HandleAudioRecorded;
        _wakeWordReceiver.OnWakeWordDetected += HandleWakeWordDetected;
        _wakeWordReceiver.OnNewUser += HandleNewUser;
        _client.OnEachTextMessage += HandleTextMessage;
    }

    /// <summary>
    /// 启动机器人，连接服务器并初始化打招呼
    /// </summary>
    public async Task StartAsync()
    {
        // 提前生成打招呼的音频
        _helloAudio = await _doubaoTtsClient.SpeakTextAsync(_config.Texts.HelloAudio, speedRate: _config.DoubaoTts.Speed);
        
        var identity = TsCrypt.GenerateNewIdentity();
        var connData = new ConnectionDataFull(
            address: _config.TeamSpeak.Host,
            identity: identity,
            username: _config.TeamSpeak.Username,
            serverPassword: _config.TeamSpeak.ServerPassword
        );

        await _scheduler.InvokeAsync(async () =>
        {
            try
            {
                await _client.Connect(connData);
                await Task.Delay(500);

                await _client.SendChannelMessage(_config.Texts.HelloAudio);
                if (_helloAudio != null)
                {
                    await _ttsAudioProducer.PlayTtsAsync(_helloAudio);
                }
                Log.Information("Bot initialized and joined the server!");
            }
            catch (Exception ex)
            {
                Log.Fatal("Unable to connect: {Exception}", ex);
            }
        });
    }

    private async void HandleAudioRecorded(ushort userId, byte[] pcmData)
    {
        try
        {
            Log.Information("Received audio data from user {UserId}, {Length} bytes total", userId, pcmData.Length);
        
            _ = _scheduler.InvokeAsync(async () =>
            {
                try { await _ttsAudioProducer.PlayTtsAsync(_beepAudio); }
                catch (Exception ex) { Log.Error("Fail to play beeping: {Exception}", ex); }
            });

            if (pcmData.Length < 1)
            {
                const string noAudioNotice = "I didn't hear anything.";
                var audio = await _doubaoTtsClient.SpeakTextAsync(noAudioNotice);
                await _scheduler.InvokeAsync(async () => { await _ttsAudioProducer.PlayTtsAsync(audio); });
                return;
            }
            
            var replyStream = _llmClient.AskWithRawPcmStreamAsync(_config.ModelApi.Model, _config.Texts.UserPrompts, pcmData);

            await _scheduler.InvokeAsync(async () =>
            {
                _ttsCts?.Cancel();
                _ttsCts?.Dispose();
                _ttsCts = new CancellationTokenSource();
                var token = _ttsCts.Token;
                
                var audioStream = _doubaoTtsClient.StreamTtsAsync(replyStream, cancellationToken: token, speedRate: _config.DoubaoTts.Speed);

                await foreach (var chunkAudio in audioStream)
                {
                    Log.Debug("Get a new audio chunk");
                    if (token.IsCancellationRequested) break;
                    await _ttsAudioProducer.PlayTtsAsync(chunkAudio, token);
                }
            });
        }
        catch (OperationCanceledException)
        {
            Log.Information("TTS playing was cancelled by user.");
        }
        catch (Exception ex)
        {
            Log.Error("Fail to request the model: {Exception}", ex);
        }
        finally
        {
            await Task.Delay(800);
            _wakeWordReceiver.ResumeListening();
        }
    }

    private void HandleWakeWordDetected(ushort userId)
    {
        _ = _scheduler.InvokeAsync(async () =>
        {
            try
            {
                var name = await GetNameFromUserId(userId);
                Log.Information("{Name} waked me up.", name);
                
                // 1. 尝试从字典中获取预加载的语音缓存
                if (!_responseAudioCache.TryGetValue(userId, out var responseAudio))
                {
                    Log.Warning("Cache miss for {Name}, synthesizing on the fly...", name);
                    responseAudio = await _doubaoTtsClient.SpeakTextAsync(
                        name + _config.Texts.ResponseAudio, 
                        speedRate: _config.DoubaoTts.Speed);
                    _responseAudioCache.TryAdd(userId, responseAudio);
                }
                
                // 2. 精准计算这段 PCM 音频的物理时长
                int durationMs = (int)(responseAudio.Length * 1000.0 / 96000.0);
                Log.Debug("Calculated audio duration: {Duration}ms, waiting...", durationMs);

                // 3. 播放音频
                await _ttsAudioProducer.PlayTtsAsync(responseAudio);
                
                // 4. 动态精准等待 
                // await Task.Delay(durationMs - 300);
                
                // 5. 时间到了！精准发令，开始录制这个用户的声音！
                _wakeWordReceiver.StartRecordingUser(userId);
            }
            catch (Exception ex)
            {
                Log.Error("Fail to play sound: {Exception}", ex);
                // 异常情况下，也要记得把锁释放，避免死锁
                _wakeWordReceiver.ResumeListening();
            }
        }); 
    }

    private async void HandleTextMessage(object? sender, TextMessage message)
    {
        try
        {
            if (message.Target != TextMessageTargetMode.Channel) return;

            var clearMessage = message.Message.Trim().ToLower();
            switch (clearMessage)
            {
                case "#stop":
                    Log.Information("{Name} shut me up.", message.InvokerName);
                    _ttsCts?.Cancel();
                    return;
                case "#clear":
                    Log.Information("{Name} clear my memory.", message.InvokerName);
                    _llmClient.ClearContext();

                    await _scheduler.InvokeAsync(async () =>
                    {
                        await _client.SendChannelMessage("记忆已清除！");
                    });
                    return;
                default:
                    if (clearMessage.StartsWith("#say"))
                    {
                        clearMessage = clearMessage.Replace("#say", "");
                        await _scheduler.InvokeAsync(async () =>
                        {
                            _ttsCts?.Cancel();
                            _ttsCts?.Dispose();
                            _ttsCts = new CancellationTokenSource();
                            var token = _ttsCts.Token;
                
                            var audio= await _doubaoTtsClient.SpeakTextAsync(clearMessage, cancellationToken: token, speedRate: _config.DoubaoTts.Speed);
                            await _ttsAudioProducer.PlayTtsAsync(audio, token);
                        });
                        
                        // return;
                    }
                    Log.Information("{Name}: {Message}", message.InvokerName, message.Message);
                    break;
            }
        }
        catch(Exception ex)
        {
            Log.Error("Fail to handle the message: {Exception}", ex);
        }
    }

    private void HandleNewUser(ushort userId)
    {
        _ = _scheduler.InvokeAsync(async () =>
        {
            try
            {
                var name = await GetNameFromUserId(userId);
                var responseAudio = await _doubaoTtsClient.SpeakTextAsync(
                    name + _config.Texts.ResponseAudio,
                    speedRate: _config.DoubaoTts.Speed);
                    
                _responseAudioCache.TryAdd(userId, responseAudio);
                
                Log.Information("Cached response audio for user {Name}", name);
            }
            catch(Exception ex)
            {
                Log.Error("Fail to cache response audio for user {UserId}: {Ex}", userId, ex.Message);
            }
        });
    }

    private async Task<string> GetNameFromUserId(ushort userId)
    {
        
        var clientId = ClientId.To(userId);
        var infoResult = await _client.ClientInfo(clientId);

        if (infoResult.Ok)
        {
            return infoResult.Value.Name;
        }

        throw new Exception(infoResult.Error.Message);
    } 

    /// <summary>
    /// 安全关闭机器人并释放资源
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        Log.Information("Disconnecting...");
        await _scheduler.InvokeAsync(async () =>
        {
            try
            {
                _wakeWordReceiver.Dispose();
                
                if (_client.Connected)
                {
                    await _client.Disconnect();
                }
                _client.Dispose();
                _scheduler.Dispose();
                _doubaoTtsClient.Dispose();
                _llmClient.Dispose();
                _ttsCts?.Dispose();
            }
            catch (Exception ex)
            {
                Log.Error("Error when disconnecting: {Exception}", ex);
            }
        });
    }
}