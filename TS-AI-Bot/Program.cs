// See https://aka.ms/new-console-template for more information

using TS_AI_Bot;
using TSLib;
using TSLib.Audio;
using TSLib.Full;
using TSLib.Scheduler;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;
using Serilog;

Log.Logger = new LoggerConfiguration().MinimumLevel.Debug().WriteTo
    .Console(outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
    .CreateLogger();

var yamlContent = File.ReadAllText("config.yaml");
using var scheduler = new DedicatedTaskScheduler(new TSLib.Helper.Id(1));
var client = new TsFullClient(scheduler);

var deserializer = new DeserializerBuilder().WithNamingConvention(PascalCaseNamingConvention.Instance).Build();

var config = deserializer.Deserialize<AppSettings>(yamlContent);
Log.Information("Config loaded!");

// 生成身份
var identity = TsCrypt.GenerateNewIdentity();

// 连接
var connData = new ConnectionDataFull(
    address: config.TeamSpeak.Host,
    identity: identity,
    username: config.TeamSpeak.Username,
    serverPassword: config.TeamSpeak.ServerPassword
);

var packetReader = new AudioPacketReader();
var decoderPipe = new DecoderPipe();
var wakeWordReceiver = new WakeWordReceiver(config.Picovoice.UsePico ? config.Picovoice.AccessKey : null);

var ttsAudioProducer = new TtsAudioProducer();
var azureTtsClient = new AzureTtsClient(config.AzureTts.Endpoint, config.AzureTts.Key);
var tsAudioSender = new TsAudioSender(client);
var volumePipe = new VolumePipe
{
    Volume = 0.45f
};
var encoderPipe = new EncoderPipe(Codec.OpusMusic);

CancellationTokenSource? ttsCts = null;

var llmClient = new OmniLlmClient(config.ModelApi.Endpoint, config.ModelApi.LlmKey); 

var safeScheduler = scheduler;

client.OutStream = packetReader;
packetReader.OutStream = decoderPipe;
decoderPipe.OutStream = wakeWordReceiver;

ttsAudioProducer.OutStream = volumePipe;
volumePipe.OutStream = encoderPipe;
encoderPipe.OutStream = tsAudioSender;

var helloAudio = await azureTtsClient.TextToSpeechAsync(config.Texts.HelloAudio);
// var wakeFeedbackAudio = await azureTtsClient.TextToSpeechAsync(config.Texts.ResponseAudio);
var beepAudio = TtsAudioProducer.GenerateBeepPcm();

wakeWordReceiver.OnAudioRecorded += async (userId, pcmData) =>
{
    Log.Information("Received audio data from user {UserId}, {Length} bytes total", userId, pcmData.Length);
    _ = safeScheduler.InvokeAsync(async () =>
    {
        try
        {
            await ttsAudioProducer.PlayTtsAsync(beepAudio);
        }
        catch (Exception ex)
        {
            Log.Error("Fail to play beeping: {Exception}", ex);
        }
    });

    try
    {
        string reply = "No Audio!";
        if (pcmData.Length > 0)
            reply = await llmClient.AskWithRawPcmAsync(config.ModelApi.Model,config.Texts.UserPrompts, pcmData);

        Log.Information("Reply from the model: {Reply}", reply);
        await safeScheduler.InvokeAsync(async () =>
        {
            
            ttsCts?.Cancel();
            ttsCts?.Dispose();

            ttsCts = new CancellationTokenSource();
            var token = ttsCts.Token;
            // client.SendChannelMessage(reply);
            // var audio = await azureTtsClient.TextToSpeechLongAsync(reply, config.AzureTts.MaxConcurrency, config.AzureTts.MaxTextLength, rateMultiplier: config.AzureTts.Speed);
            // await ttsAudioProducer.PlayTtsAsync(audio, ttsCts.Token);

            var audioStream = azureTtsClient.TextToSpeechStreamAsync(
                reply,
                config.AzureTts.MaxConcurrency,
                config.AzureTts.MaxTextLength,
                config.AzureTts.Speed,
                token);

            await foreach (var chunkAudio in audioStream.WithCancellation(token))
            {
                if (token.IsCancellationRequested)
                    break;
                await ttsAudioProducer.PlayTtsAsync(chunkAudio, token);
            }
        });
    }
    catch (OperationCanceledException)
    {
        // 捕获打断信号引发的取消异常，忽略
        Log.Information("TTS playing was cancelled by user.");
    }
    catch (Exception ex)
    {
        Log.Error("Fail to request the model: {Exception}", ex);
        // await safeScheduler.Invoke(() => { client.SendChannelMessage(ex.ToString()); });
    }
    finally
    {
        await Task.Delay(800);
        wakeWordReceiver.ResumeListening();
    }
};

wakeWordReceiver.OnWakeWordDetected += (userId) =>
{
    // 使用弃元 `_` 来触发异步任务，不阻塞当前线程，一边播放一边录音
    _ = safeScheduler.InvokeAsync(async () =>
    {
        try
        {
            var clientId = ClientId.To(userId);
            var infoResult = await client.ClientInfo(clientId);

            if (infoResult.Ok)
            {
                var info = infoResult.Value;

                Log.Information("{Name} waked me up!", info.Name);

                var responseAudio = await azureTtsClient.TextToSpeechAsync(info.Name + config.Texts.ResponseAudio);
                
                await ttsAudioProducer.PlayTtsAsync(responseAudio);
            }
            else
            {
                throw new Exception(infoResult.Error.Message);
            }
        }
        catch (Exception ex)
        {
            Log.Error("Fail to play sound: {Exception}", ex);
        }
    });
};

client.OnEachTextMessage += (_, message) =>
{
    if (message.Target == TextMessageTargetMode.Channel)
    {
        if (message.Message.Trim().ToLower() == "#stop")
        {
            Log.Information("{Name} shut me up.", message.InvokerName);
            
            ttsCts?.Cancel();
            return;
        }
        
        Log.Debug("{Name}: {Message}", message.InvokerName, message.Message);
    }
};

await scheduler.InvokeAsync(async () =>
{
    try
    {
        await client.Connect(connData);
        await Task.Delay(500);

        // 发送消息

        await client.SendChannelMessage(config.Texts.HelloAudio);
        await ttsAudioProducer.PlayTtsAsync(helloAudio);
        Log.Information("Bot initialized!");
    }
    catch (Exception ex)
    {
        Log.Fatal("Unable to connect: {Exception}", ex);
    }
});

var shutdownTcs = new TaskCompletionSource();
var cleanupFinishedTcs = new TaskCompletionSource();

AppDomain.CurrentDomain.ProcessExit += (_, _) =>
{
    Log.Information("Shutting down...");
    shutdownTcs.TrySetResult();

    cleanupFinishedTcs.Task.Wait();
};

Console.CancelKeyPress += (_, e) =>
{
    Log.Information("Shutting down...");
    e.Cancel = true;
    shutdownTcs.TrySetResult();
};

await shutdownTcs.Task;

Log.Information("Disconnecting...");

await safeScheduler.InvokeAsync(async () =>
{
    try
    {
        // 停止监听唤醒词
        wakeWordReceiver.Dispose();
        
        // 断开连接
        if (client.Connected)
        {
            await client.Disconnect();
        }
        client.Dispose();
    }
    catch (Exception ex)
    {
        Log.Error("Error when disconnecting: {Exception}", ex);
    }
});

cleanupFinishedTcs.TrySetResult();
