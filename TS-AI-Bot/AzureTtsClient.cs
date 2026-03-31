using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.CompilerServices;
using Microsoft.CognitiveServices.Speech;
using Serilog;

namespace TS_AI_Bot;

public class AzureTtsClient
{
    private readonly SpeechConfig _speechConfig;

    public AzureTtsClient(string endpoint, string apiKey)
    {
        // 使用传入的 Endpoint 和 Key 初始化配置
        _speechConfig = SpeechConfig.FromEndpoint(new Uri(endpoint), apiKey);

        // Raw48Khz16BitMonoPcm 代表 48000Hz, 16位, 单声道纯 PCM 数据（无 WAV 头）
        _speechConfig.SetSpeechSynthesisOutputFormat(SpeechSynthesisOutputFormat.Raw48Khz16BitMonoPcm);
        
        _speechConfig.SpeechSynthesisVoiceName = "zh-CN-XiaoxiaoNeural"; 
    }

    /// <summary>
    /// 处理长文本的并发 TTS 合成
    /// </summary>
    public async Task<byte[]> TextToSpeechLongAsync(string longText, int maxConcurrency = 10, int maxTextLength = 75, float rateMultiplier = 1.0f)
    {
        if (string.IsNullOrWhiteSpace(longText))
        {
            return Array.Empty<byte>();
        }
        
        List<string> chunks = SplitTextIntoChunks(longText, maxTextLength);
        Log.Information("Divided text into {Number} chunks.", chunks.Count);
        
        using var semaphore = new SemaphoreSlim(maxConcurrency);
        var safeSemaphore = semaphore;

        var tasks = chunks.Select(async chunk =>
        {
            await safeSemaphore.WaitAsync();
            try
            {
                // 将语速参数向下传递
                return await TextToSpeechAsync(chunk, rateMultiplier);
            }
            finally
            {
                safeSemaphore.Release();
            }
        });
        
        var results = await Task.WhenAll(tasks);
        
        using var ms = new MemoryStream();
        foreach (var audioData in results)
        {
            if (audioData is { Length: > 0 })
            {
                ms.Write(audioData, 0, audioData.Length); 
            }
        }
        
        byte[] finalAudio = ms.ToArray();
        Log.Information("TTS completed! Got {Length} bytes of audio data.", finalAudio.Length);
        return finalAudio;
    }
    public async IAsyncEnumerable<byte[]> TextToSpeechStreamAsync(
        string longText, 
        int maxConcurrency = 10, 
        int maxTextLength = 75, 
        float rateMultiplier = 1.0f,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(longText))
        {
            yield break;
        }
    
        List<string> chunks = SplitTextIntoChunks(longText, maxTextLength);
        Log.Information("Divided text into {Number} chunks for streaming.", chunks.Count);
    
        using var semaphore = new SemaphoreSlim(maxConcurrency);

        var tasks = chunks.Select(async chunk =>
        {
            await semaphore.WaitAsync(cancellationToken);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                return await TextToSpeechAsync(chunk, rateMultiplier);
            }
            finally
            {
                semaphore.Release();
            }
        }).ToList(); 
    
        foreach (var task in tasks)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var audioData = await task;
        
            if (audioData is { Length: > 0 })
            {
                // 一旦当前的包准备好了，立刻扔出去给播放器
                yield return audioData; 
            }
        }
    
        Log.Information("TTS streaming completed!");
    }

    /// <summary>
    /// 将文本合成为纯 PCM 音频字节流
    /// </summary>
    /// <param name="text">要朗读的文本</param>
    /// <param name="rateMultiplier">语速倍率 (默认 1.0)</param>
    /// <returns>PCM 裸流 byte[]</returns>
    public async Task<byte[]> TextToSpeechAsync(string text, float rateMultiplier = 1.0f)
    {
        // 第二个参数传 null，表示【不要】直接在电脑扬声器播放，而是输出到内存中
        using var synthesizer = new SpeechSynthesizer(_speechConfig, null);

        string ssml = BuildSsml(text, rateMultiplier);

        SpeechSynthesisResult result = await synthesizer.SpeakSsmlAsync(ssml);

        if (result.Reason == ResultReason.SynthesizingAudioCompleted)
        {
            return result.AudioData;
        }
        if (result.Reason == ResultReason.Canceled)
        {
            var cancellation = SpeechSynthesisCancellationDetails.FromResult(result);
            throw new Exception($"TTS 合成被取消: {cancellation.Reason}, 详情: {cancellation.ErrorDetails}");
        }

        throw new Exception($"TTS 合成失败，未知错误: {result.Reason}");
    }

    /// <summary>
    /// 构造带语速控制的 SSML (Speech Synthesis Markup Language) 字符串
    /// </summary>
    private string BuildSsml(string text, float rateMultiplier)
    {
        // 必须对文本进行 HTML 转义，防止大模型生成的文本里含有 '<' 或 '&' 导致 XML 解析崩溃
        var safeText = WebUtility.HtmlEncode(text);
        var voiceName = _speechConfig.SpeechSynthesisVoiceName;

        // rate 支持倍率格式（如 1.2）或百分比格式（如 +20%）
        return $@"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>
                    <voice name='{voiceName}'>
                        <prosody rate='{rateMultiplier}'>
                            {safeText}
                        </prosody>
                    </voice>
                  </speak>";
    }

    private List<string> SplitTextIntoChunks(string text, int maxChunkLength)
    {
        var chunks = new List<string>();
        
        var sentences = Regex.Split(text, @"(?<=[。！？\.\!\?\n])")
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .ToList();

        StringBuilder currentChunk = new StringBuilder();

        foreach (var sentence in sentences)
        {
            if (currentChunk.Length + sentence.Length > maxChunkLength && currentChunk.Length > 0)
            {
                chunks.Add(currentChunk.ToString());
                currentChunk.Clear();
            }
            currentChunk.Append(sentence);
        }

        if (currentChunk.Length > 0)
        {
            chunks.Add(currentChunk.ToString());
        }

        return chunks;
    }
}