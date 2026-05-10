using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Python.Runtime;
using Serilog;
using TSLib.Audio;

namespace TS_AI_Bot;

public class VoiceCloneTtsClient(string model, string baseUrl, string apiKey, int durationSeconds = 7) : IAudioPassiveConsumer, IDisposable
{
    public bool Active { get; private set; }

    public ushort? ActiveSpeakerId;

    public record VoiceInfo(ushort SpeakerId, string VoiceId);

    private readonly MemoryStream _audioBuffer = new();
    private readonly object _lockObj = new();

    private int _bytesReceived;
    private const int BytesSecond = 48000 * 2 * 2;

    private TaskCompletionSource? _completionSource;
    
    private static readonly HttpClient Client = new();
    
    private readonly Dictionary<string, VoiceInfo> _createdVoices = new();

    public void Write(Span<byte> data, Meta? meta)
    {
        if (meta is null) return;
        ushort senderId = meta.In.Sender.Value;

        lock (_lockObj)
        {
            if (ActiveSpeakerId != senderId) return;
            _audioBuffer.Write(data);
            _bytesReceived += data.Length;

            if (_bytesReceived < durationSeconds * BytesSecond) return;
            Active = false;
            ActiveSpeakerId = null;
            
            _completionSource?.TrySetResult();
        }
    }

    public async Task CreateVoiceAsync(ushort speakerId, string speakerName)
    {
        lock (_lockObj)
        {
            if (Active)
            {
                throw new InvalidOperationException("Cannot create voice when it is already recording.");
            }
            Active = true;
            ActiveSpeakerId = speakerId;
            _completionSource = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            _bytesReceived = 0;
            _audioBuffer.SetLength(0);
        }
        
        await _completionSource.Task;

        var wavBytes = AudioUtils.WrapPcmToWav(_audioBuffer.ToArray(), 48000, 2, 16);
        
        var base64Str = Convert.ToBase64String(wavBytes);
        string dataUri = $"data:audio/wav;base64,{base64Str}";

        // 3. 构建 JSON 负载 (使用 System.Text.Json.Nodes 构建动态结构)
        var payload = new
        {
            model = "qwen-voice-enrollment",
            input = new
            {
                action = "create",
                target_model = model,
                preferred_name = "nobody",
                audio = new { data = dataUri }
            }
        };

        string jsonPayload = JsonSerializer.Serialize(payload);

        // 4. 配置请求
        using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = new StringContent(jsonPayload, Encoding.UTF8, "application/json");

        // 5. 发送请求
        Log.Information("Sending request to {url}", baseUrl);
        HttpResponseMessage response = await Client.SendAsync(request);
        string responseText = await response.Content.ReadAsStringAsync();

        if (!response.IsSuccessStatusCode)
        {
            throw new Exception($"Fail to create voice {response.StatusCode}, {responseText}");
        }

        // 6. 解析响应
        try
        {
            var jsonDoc = JsonDocument.Parse(responseText);
            var voice = jsonDoc.RootElement
                .GetProperty("output")
                .GetProperty("voice")
                .GetString() ?? throw new Exception("Voice 字段为空");
            Log.Information("Voice created for {speakerId}", speakerId);
            _createdVoices[speakerName] = new VoiceInfo(speakerId, voice);
        }
        catch (Exception e)
        {
            throw new Exception($"解析 voice 响应失败: {e.Message}");
        }
    }
    public async IAsyncEnumerable<byte[]> StreamTtsAsync(string speakerName, string text, [EnumeratorCancellation]CancellationToken cancellationToken = default)
    {
        await Task.Yield();

        using (Py.GIL())
        {
            // 直接导入原生 SDK
            dynamic dashscope = Py.Import("dashscope");
            dashscope.base_http_api_url = "https://dashscope.aliyuncs.com/api/v1";

            // 直接发起流式调用
            dynamic response = dashscope.MultiModalConversation.call(
                model: model,
                api_key: apiKey,
                text: text,
                voice: _createdVoices[speakerName].VoiceId,
                stream: true
            );

            // 3. 迭代 Python 生成器
            foreach (dynamic chunk in response)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (chunk.status_code == 200)
                {
                    // 解析 Base64 数据并返回字节数组
                    string? base64 = chunk.output.audio?.data.ToString();
                    if (!string.IsNullOrEmpty(base64))
                    {
                        var raw24K = Convert.FromBase64String(base64);
                        var upsampled48K = AudioUtils.Resample24KTo48K(raw24K);
                        yield return upsampled48K;
                        await Task.Yield();
                    }
                }
                else
                {
                    throw new Exception($"DashScope Error: {chunk.message}");
                }
            }
        }
    }

    public bool IsSpeakerExisted(string speakerName)
    {
        return _createdVoices.ContainsKey(speakerName);
    }
    public void Dispose()
    {
        lock (_lockObj)
        {
            _completionSource?.TrySetCanceled();
            _audioBuffer.Dispose();
        }
    }
}