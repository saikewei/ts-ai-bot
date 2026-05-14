using Serilog;
using TSLib;
using TSLib.Audio;
using TSLib.Full;
using TSLib.Messages;
using TSLib.Scheduler;
using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.IdentityModel.Tokens;
using Python.Runtime;
using QRCoder.Core.Generators;
using QRCoder.Core.Renderers;

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

    // 语音克隆客户端
    private readonly VoiceCloneTtsClient _voiceCloneTtsClient;

    // AI 客户端
    private readonly DoubaoTtsClient _doubaoTtsClient;
    private readonly OmniLlmClient _llmClient;

    // 状态与缓存
    private CancellationTokenSource? _ttsCts;
    private readonly byte[] _beepAudio;
    private byte[]? _helloAudio;
    private readonly ConcurrentDictionary<ushort, byte[]> _responseAudioCache;
    private string _currentVoice = "default";
    private static readonly MemoryCache Cache = new(new MemoryCacheOptions());

    // web
    private WebApplication? _webApplication;
    private readonly string _jwtSecretKey;

    public TsBot(AppSettings config)
    {
        _config = config;

        // 1. 初始化 TS 客户端与调度器
        _scheduler = new DedicatedTaskScheduler(new TSLib.Helper.Id(1));
        _client = new TsFullClient(_scheduler);
        _jwtSecretKey = _config.WebServer.JwtSecretKey;
        StartWebServer();

        // 2. 初始化 AI 客户端
        _doubaoTtsClient = new DoubaoTtsClient(_config.DoubaoTts.AppId, _config.DoubaoTts.AccessToken,
            _config.DoubaoTts.Voice);
        _llmClient = new OmniLlmClient(_config.ModelApi.Endpoint, _config.ModelApi.LlmKey, _config.ModelApi.Model,
            _config.ModelApi.MaxContextTurns);

        // 3. 初始化音频组件
        var packetReader = new AudioPacketReader();
        var decoderPipe = new DecoderPipe();
        var splitterPipe = new PassiveSplitterPipe();
        _voiceCloneTtsClient =
            new VoiceCloneTtsClient(_config.QwenTts.Model, _config.QwenTts.BaseUrl, _config.QwenTts.ApiKey,
                _config.QwenTts.VoiceSamplingDuration, _config.QwenTts.VoiceSamplingTimeout);
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
        decoderPipe.OutStream = splitterPipe;
        splitterPipe.Add(_wakeWordReceiver);
        splitterPipe.Add(_voiceCloneTtsClient);

        _ttsAudioProducer.OutStream = volumePipe;
        volumePipe.OutStream = encoderPipe;
        encoderPipe.OutStream = tsAudioSender;

        // 5. 绑定事件
        _wakeWordReceiver.OnAudioRecorded += HandleAudioRecorded;
        _wakeWordReceiver.OnWakeWordDetected += HandleWakeWordDetected;
        _wakeWordReceiver.OnNewUser += HandleNewUser;
        _client.OnEachTextMessage += HandleTextMessage;

        Runtime.PythonDLL = Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") == "true"
            ? "/usr/lib/x86_64-linux-gnu/libpython3.11.so.1.0"
            : "/usr/lib/x86_64-linux-gnu/libpython3.12.so.1.0";
        if (!PythonEngine.IsInitialized)
        {
            PythonEngine.Initialize();
            PythonEngine.BeginAllowThreads();
        }
    }

    /// <summary>
    /// 启动机器人，连接服务器并初始化打招呼
    /// </summary>
    public async Task StartAsync()
    {
        // 提前生成打招呼的音频
        _helloAudio =
            await _doubaoTtsClient.SpeakTextAsync(_config.Texts.HelloAudio, speedRate: _config.DoubaoTts.Speed);

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
                try
                {
                    await _ttsAudioProducer.PlayTtsAsync(_beepAudio);
                }
                catch (Exception ex)
                {
                    Log.Error("Fail to play beeping: {Exception}", ex);
                }
            });

            if (pcmData.Length < 1)
            {
                const string noAudioNotice = "I didn't hear anything.";
                var audio = await _doubaoTtsClient.SpeakTextAsync(noAudioNotice);
                await _scheduler.InvokeAsync(async () => { await _ttsAudioProducer.PlayTtsAsync(audio); });
                return;
            }

            var replyStream =
                _llmClient.AskWithRawPcmStreamAsync(_config.ModelApi.Model, _config.Texts.UserPrompts, pcmData);

            await _scheduler.InvokeAsync(async () =>
            {
                _ttsCts?.Cancel();
                _ttsCts?.Dispose();
                _ttsCts = new CancellationTokenSource();
                var token = _ttsCts.Token;

                var audioStream = _doubaoTtsClient.StreamTtsAsync(replyStream, cancellationToken: token,
                    speedRate: _config.DoubaoTts.Speed);

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

            var clearMessage = message.Message;
            switch (clearMessage)
            {
                case "#stop":
                    Log.Information("{Name} shut me up.", message.InvokerName);
                    _ttsCts?.Cancel();
                    return;
                case "#clear":
                    Log.Information("{Name} clear my memory.", message.InvokerName);
                    _llmClient.ClearContext();

                    await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage("记忆已清除！"); });
                    return;
                case "#refreshQR":
                    var ticket = GetNewTicket(20);
                    var qrcode = GenerateQrCode(_config.WebServer.LoginUrl, ticket);
                    await SetAvatar(qrcode);

                    return;
                case "#list":
                    var names = await GetAllUserName();
                    var messageToShow = "|" + string.Join("|", names) + "|";

                    await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage(messageToShow); });
                    return;
                case "#list voice":
                    var namesToShow = "|" + string.Join("|", _voiceCloneTtsClient.SpeakerNames) + "|";

                    await _scheduler.InvokeAsync(async () =>
                    {
                        await _client.SendChannelMessage("目前已克隆的用户：" + namesToShow);
                    });

                    return;
                default:
                    Log.Information("{Name}: {Message}", message.InvokerName, message.Message);
                    if (clearMessage.StartsWith("#say "))
                    {
                        clearMessage = clearMessage.Replace("#say ", "");
                        await SayAsync(clearMessage);
                        // return;
                    }
                    else if (clearMessage.StartsWith("#clone "))
                    {
                        var speakerName = clearMessage.Replace("#clone ", "");
                        try
                        {

                            _ttsCts?.Cancel();
                            _ttsCts?.Dispose();
                            _ttsCts = new CancellationTokenSource();
                            var token = _ttsCts.Token;

                            var speakerId = await GetUserIdFromName(speakerName);
                            Log.Information("Start to clone voice from {name}", speakerName);
                            await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage("声音开始克隆！"); });
                            await _voiceCloneTtsClient.CreateVoiceAsync(speakerId, speakerName, token);
                            await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage("声音已克隆！"); });
                        }
                        catch (KeyNotFoundException)
                        {
                            await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage("用户名不存在！"); });
                        }
                        catch (Exception ex) when (ex is OperationCanceledException or TimeoutException)
                        {
                            Log.Information(ex, "Stop the clone");
                            await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage("克隆终止！"); });
                        }
                    }
                    else if (clearMessage.StartsWith("#voice "))
                    {
                        var voiceName = clearMessage.Replace("#voice ", "");
                        if (voiceName != "default" && !_voiceCloneTtsClient.SpeakerNames.Contains(voiceName))
                        {
                            await _scheduler.InvokeAsync(async () =>
                            {
                                await _client.SendChannelMessage($"需要先创建{voiceName}的音色");
                            });

                            return;
                        }

                        _currentVoice = voiceName;
                        await _scheduler.InvokeAsync(async () =>
                        {
                            await _client.SendChannelMessage($"已切换至{voiceName}音色");
                        });
                    }

                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error(ex, "Fail to handle the message");
            await _scheduler.InvokeAsync(async () => { await _client.SendChannelMessage($"处理消息出错了！{ex.Message}"); });
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

                Log.Information("Cached response audio for user {Id} {Name}", userId, name);
            }
            catch (Exception ex)
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

    private async Task<ushort> GetUserIdFromName(string name)
    {
        var info = await _client.ClientList();
        if (!info.Ok) throw new Exception(info.Error.Message);
        foreach (var clientInfo in info.Value)
        {
            if (clientInfo.Name == name) return clientInfo.ClientId.Value;
        }

        throw new KeyNotFoundException("Cannot find the name");
    }

    private async Task<List<string>> GetAllUserName()
    {
        var info = await _client.ClientList();
        if (!info.Ok) throw new Exception(info.Error.Message);
        var result = info.Value.Select(clientInfo => clientInfo.Name).ToList();

        return result;
    }

    private async Task SayAsync(string words, string? voiceName = null)
    {
        _ttsCts?.Cancel();
        _ttsCts?.Dispose();
        _ttsCts = new CancellationTokenSource();
        var token = _ttsCts.Token;
        await _scheduler.InvokeAsync(async () =>
        {
            if (_currentVoice == "default" && voiceName == null)
            {
                var audio = await _doubaoTtsClient.SpeakTextAsync(words, cancellationToken: token,
                    speedRate: _config.DoubaoTts.Speed);
                await _ttsAudioProducer.PlayTtsAsync(audio, token);
            }
            else
            {
                try
                {
                    await foreach (var pcmData in _voiceCloneTtsClient.StreamTtsAsync(voiceName ?? _currentVoice,
                                       words, token))
                    {
                        if (pcmData.Length > 0)
                        {
                            await _ttsAudioProducer.PlayTtsAsync(pcmData, token);
                        }
                    }
                }
                catch (TaskCanceledException)
                {
                    Log.Information("Stop streaming tts");
                }
            }
        });
    }

    private async Task SetAvatar(Stream imageStream)
    {
        var result = await _client.UploadAvatar(imageStream);
        if (!result.Ok) throw new Exception($"Upload failed, result:{result.Error.Message}");
        Log.Information("image uploaded.");
    }

    private static string GetNewTicket(int timeoutSeconds)
    {
        var ticket = Guid.NewGuid().ToString("N");
        Cache.Set(ticket, TimeSpan.FromSeconds(timeoutSeconds));
        Log.Information("new ticket: {ticket}", ticket);

        return ticket;
    }

    private static bool VerifyTicket(string ticket)
    {
        if (!Cache.TryGetValue(ticket, out var _)) return false;
        Cache.Remove(ticket);
        return true;
    }

    private static MemoryStream GenerateQrCode(string targetUrl, string ticket)
    {
        using var qrGenerator = new QRCodeGenerator();
        using var qrCodeData = qrGenerator.CreateQrCode(targetUrl + $"?ticket={ticket}", QRCodeGenerator.ECCLevel.Q);
        
        using var qrCode = new PngByteQRCode(qrCodeData);
        var qrCodeBytes= qrCode.GetGraphic(5);

        var memoryStream = new MemoryStream(qrCodeBytes, writable: false);
        
        memoryStream.Position = 0;
        return memoryStream;
    }

    private string GenerateJwtToken()
    {
        var tokenHandler = new JwtSecurityTokenHandler();
        var key = Encoding.UTF8.GetBytes(_jwtSecretKey);
        
        var tokenDescriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")]),
            
            // 设置 Token 有效期
            Expires = DateTime.UtcNow.AddDays(30),
            
            // 使用 HMAC SHA256 算法签名
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(key), 
                SecurityAlgorithms.HmacSha256Signature)
        };

        var token = tokenHandler.CreateToken(tokenDescriptor);
        return tokenHandler.WriteToken(token);
    }

    private void StartWebServer()
    {
        var builder= WebApplication.CreateBuilder();
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(options =>
            {
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = false,   // 不验证签发方 
                    ValidateAudience = false, // 不验证接收方
                    ValidateLifetime = true,  // 验证 Token 是否过期
                    ValidateIssuerSigningKey = true, // 必须验证密钥
                    IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_jwtSecretKey))
                };
            });
            
        builder.Services.AddAuthorization(); //
        
        _webApplication = builder.Build();

        _webApplication.UseAuthentication();
        _webApplication.UseAuthorization();
        
        //TODO: mount static front page
        
        SetWebApi(); 
        _ = _webApplication.RunAsync();
        Log.Information("Web server started");
    }

    private void SetWebApi()
    {
        _webApplication?.MapGet("/api/status", () => Results.Ok(new {Status = "Running"}));
        
        _webApplication?.MapGet("/api/voices", () =>
        {
            var voices = _voiceCloneTtsClient.SpeakerNames;
            return Results.Ok(voices);
        }).RequireAuthorization();
        
        _webApplication?.MapGet("/api/say", (string voice, string text) =>
        {
            Task.Run(async () =>
            {
                try
                {
                    await SayAsync(text, voice);
                }
                catch (Exception ex)
                {
                    Log.Error(ex, "voice error");
                }
            });
            
            return Results.Ok(new {Message = "Start playing" });
        }).RequireAuthorization();
        
        _webApplication?.MapGet("/api/stop", () =>
        {
            _ttsCts?.Cancel();
            Results.Ok(new { Message = "Stop everything" });
        }).RequireAuthorization();
        
        _webApplication?.MapGet("/api/verify-ticket", (string ticket) =>
        {
            if (VerifyTicket(ticket))
            {
                var jwtToken = GenerateJwtToken();
                
                return Results.Ok(new { Message = "Ticket is valid.", Token = jwtToken });
            }
            return Results.Unauthorized();
        });
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
                _voiceCloneTtsClient.Dispose();
            }
            catch (Exception ex)
            {
                Log.Error("Error when disconnecting: {Exception}", ex);
            }
        });
    }
}