using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Serilog;

namespace TS_AI_Bot;

public class OmniLlmClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly string _endpoint;
    
    public OmniLlmClient(string endpoint, string apiKey)
    {
        _endpoint = endpoint;
        _httpClient = new HttpClient();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        _httpClient.DefaultRequestHeaders.Add("HTTP-Referer", "http://localhost"); 
        _httpClient.DefaultRequestHeaders.Add("X-Title", "TS-AI-Bot");
    }
    /// <summary>
    /// 接口 1：接受本地音频文件 (用于单元测试或本地预录制的文件)
    /// </summary>
    public async Task<string> AskWithAudioFileAsync(string model, string prompt, string filePath)
    {
        if (!File.Exists(filePath))
            throw new FileNotFoundException($"找不到音频文件: {filePath}");

        var fileBytes = await File.ReadAllBytesAsync(filePath);
        var base64Audio = Convert.ToBase64String(fileBytes);
        var format = Path.GetExtension(filePath).TrimStart('.').ToLower(); // 获取 wav, mp3 等

        // 调用私有核心方法
        return await SendAudioRequestAsync(model, prompt, base64Audio, format);
    }

    /// <summary>
    /// 接口 2：接受内存中的纯 PCM 裸流 (用于直接对接 TeamSpeak 实时语音)
    /// </summary>
    public async Task<string> AskWithRawPcmAsync(string model, string prompt, byte[] pcmData, int sampleRate = 48000, short channels = 2, short bitsPerSample = 16)
    {
        // 1. 在内存中强行给 PCM 数据戴上一个标准的 WAV 帽子
        var wavBytes = WrapPcmToWav(pcmData, sampleRate, channels, bitsPerSample);
        
        // 2. 转为 Base64
        var base64Audio = Convert.ToBase64String(wavBytes);

        // 3. 告诉模型这是一个 wav 格式的数据，并调用私有核心方法
        return await SendAudioRequestAsync(model, prompt, base64Audio, "wav");
    }
    private async Task<string> SendAudioRequestAsync(string model, string prompt, string base64Audio, string format)
    {
        // 1. 映射标准的 MIME Type
        var mimeType = format.ToLower() switch
        {
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            _ => $"audio/{format}"
        };

        // 2. 拼接成完整的 Data URI 格式
        var dataUri = $"data:{mimeType};base64,{base64Audio}";

        // 3. 动态获取今天的日期，让模型拥有真正的时间感知
        var currentDate = DateTime.Now.ToString("yyyy年MM月dd日，dddd");
    
        // 4. 纯正的中文 System Prompt（明确要求中文回复）
        var systemPrompt = $"你是MiMo，由小米开发的人工智能助手。今天是：{currentDate}。你的知识截止日期是2024年12月。请始终使用流畅、自然的语言与用户进行交流。";

        // 5. 结构组装 Payload
        var requestPayload = new
        {
            model,
            messages = new object[]
            {
                // 插入 System Prompt
                new
                {
                    role = "system",
                    content = systemPrompt
                },
                // 用户的音频与文字混合输入
                new
                {
                    role = "user",
                    content = new object[]
                    {
                        new 
                        { 
                            type = "input_audio", 
                            input_audio = new 
                            { 
                                data = dataUri 
                            } 
                        },
                        new 
                        { 
                            type = "text", 
                            text = prompt 
                        }
                    }
                }
            }
        };

        var jsonString = JsonSerializer.Serialize(requestPayload);
        using var content = new StringContent(jsonString, Encoding.UTF8, "application/json");
        var response = await _httpClient.PostAsync(_endpoint, content);
        var responseContent = await response.Content.ReadAsStringAsync();
        
        if (!response.IsSuccessStatusCode)
        {
            throw new Exception($"Api request failed! Code: {response.StatusCode}. Message: {responseContent}");
        }
        
        var startIndex = responseContent.IndexOf('{');
        var endIndex = responseContent.LastIndexOf('}');

        if (startIndex >= 0 && endIndex >= startIndex)
        {
            // 强制截取纯正的 JSON 字符串
            responseContent = responseContent.Substring(startIndex, endIndex - startIndex + 1);
        }
        else
        {
            throw new Exception("服务器返回的内容中没有找到有效的 JSON 结构。");
        }

        // 安全解析清洗后的 JSON
        using var jsonDoc = JsonDocument.Parse(responseContent);

        // 提取大模型的回复内容
        var reply = jsonDoc.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString();

        return reply ?? string.Empty;
    }
    /// <summary>
    /// 接口 3：流式请求大模型 (接收内存 PCM 裸流，返回异步文本流)
    /// </summary>
    public async IAsyncEnumerable<string> AskWithRawPcmStreamAsync(
        string model, 
        string prompt, 
        byte[] pcmData, 
        int sampleRate = 48000, 
        short channels = 2, 
        short bitsPerSample = 16, 
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 1. 给 PCM 加上 WAV 头
        var wavBytes = WrapPcmToWav(pcmData, sampleRate, channels, bitsPerSample);
        
        // 2. 转为 Base64
        var base64Audio = Convert.ToBase64String(wavBytes);

        // 3. 异步迭代私有流式方法
        await foreach (var chunk in SendAudioRequestStreamAsync(model, prompt, base64Audio, "wav", cancellationToken))
        {
            yield return chunk;
        }
    }
    /// <summary>
    /// 接口 4：流式请求大模型 (接受本地音频文件)
    /// </summary>
    public async IAsyncEnumerable<string> AskWithAudioFileStreamAsync(
        string model, 
        string prompt, 
        string filePath, 
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (!File.Exists(filePath))
            throw new FileNotFoundException($"找不到音频文件: {filePath}");

        var fileBytes = await File.ReadAllBytesAsync(filePath, cancellationToken);
        var base64Audio = Convert.ToBase64String(fileBytes);
        var format = Path.GetExtension(filePath).TrimStart('.').ToLower();

        await foreach (var chunk in SendAudioRequestStreamAsync(model, prompt, base64Audio, format, cancellationToken))
        {
            yield return chunk;
        }
    }

    /// <summary>
    /// 私有核心流式请求方法
    /// </summary>
    private async IAsyncEnumerable<string> SendAudioRequestStreamAsync(
        string model, 
        string prompt, 
        string base64Audio, 
        string format, 
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var mimeType = format.ToLower() switch
        {
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            _ => $"audio/{format}"
        };

        var dataUri = $"data:{mimeType};base64,{base64Audio}";
        var currentDate = DateTime.Now.ToString("yyyy年MM月dd日，dddd");
        var systemPrompt = $"你是MiMo，由小米开发的人工智能助手。今天是：{currentDate}。你的知识截止日期是2024年12月。请始终使用流畅、自然的语言与用户进行交流。";

        var requestPayload = new
        {
            model,
            stream = true, // 🌟 关键：告诉大模型开启流式传输
            messages = new object[]
            {
                new { role = "system", content = systemPrompt },
                new
                {
                    role = "user",
                    content = new object[]
                    {
                        new { type = "input_audio", input_audio = new { data = dataUri } },
                        new { type = "text", text = prompt }
                    }
                }
            }
        };

        var jsonString = JsonSerializer.Serialize(requestPayload);
        using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint);
        request.Content = new StringContent(jsonString, Encoding.UTF8, "application/json");

        // 🌟 核心性能优化：ResponseHeadersRead 告诉 HttpClient 只要拿到响应头就开始返回，不要等整个 Body 下载完！
        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        
        if (!response.IsSuccessStatusCode)
        {
            var errorContent = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new Exception($"流式 API 请求失败! 状态码: {response.StatusCode}. 详情: {errorContent}");
        }

        // 获取响应流并逐行读取 (Server-Sent Events 标准格式)
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            
            if (string.IsNullOrWhiteSpace(line)) continue;
            
            // SSE 的数据行都是以 "data: " 开头的
            if (line.StartsWith("data: "))
            {
                var data = line.Substring(6).Trim();
                
                // 收到结束标志符，退出流
                if (data == "[DONE]") break;

                string chunkText = string.Empty;
                try
                {
                    using var jsonDoc = JsonDocument.Parse(data);
                    var choices = jsonDoc.RootElement.GetProperty("choices");
                    if (choices.GetArrayLength() > 0)
                    {
                        var delta = choices[0].GetProperty("delta");
                        
                        // 🌟 只提取 content (说话内容)，忽略 reasoning_content (思考过程)
                        if (delta.TryGetProperty("content", out var contentElement) && contentElement.ValueKind == JsonValueKind.String)
                        {
                            chunkText = contentElement.GetString() ?? string.Empty;
                        }
                    }
                }
                catch (JsonException)
                {
                    // 忽略个别不完整的 JSON 块解析异常，保证流不断
                }

                if (!string.IsNullOrEmpty(chunkText))
                {
                    yield return chunkText; // 将解析出的片段实时扔给外部
                }
            }
        }
    }
    
    private static byte[] WrapPcmToWav(byte[] pcmData, int sampleRate, short channels, short bitsPerSample)
    {
        var wavBytes = new byte[44 + pcmData.Length];
        using var ms = new MemoryStream(wavBytes);
        using var writer = new BinaryWriter(ms);
        
        writer.Write(Encoding.ASCII.GetBytes("RIFF"));
        writer.Write(36 + pcmData.Length);
        writer.Write(Encoding.ASCII.GetBytes("WAVE"));
        writer.Write(Encoding.ASCII.GetBytes("fmt "));
        writer.Write(16);
        writer.Write((short)1);
        writer.Write(channels);
        writer.Write(sampleRate);
        writer.Write(sampleRate * channels * bitsPerSample / 8);
        writer.Write((short)(channels * bitsPerSample / 8));
        writer.Write(bitsPerSample);
        writer.Write(Encoding.ASCII.GetBytes("data"));
        writer.Write(pcmData.Length);
        writer.Write(pcmData);
        
        return wavBytes;
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }
}