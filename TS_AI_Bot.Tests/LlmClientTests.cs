using System.Text;
using Xunit.Abstractions;
using YamlDotNet.Serialization.NamingConventions;
using YamlDotNet.Serialization;

namespace TS_AI_Bot.Tests;

public class LlmClientTests
{
    private readonly ITestOutputHelper _output;

    public LlmClientTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public async Task Test_Audio_Understanding_With_File()
    {
        
        var yamlContent = await File.ReadAllTextAsync("config.yaml");
        
        var deserializer = new DeserializerBuilder().WithNamingConvention(PascalCaseNamingConvention.Instance).Build();
        
        var config = deserializer.Deserialize<AppSettings>(yamlContent);
        // Arrange
        const string prompt = "你从音频中听到了什么?";
        
        const string testAudioPath = "/mnt/d/temp/a.wav"; 
        Assert.True(File.Exists(testAudioPath), $"测试音频文件丢失: {testAudioPath}");

        using var client = new OmniLlmClient(config.ModelApi.Endpoint, config.ModelApi.LlmKey, config.ModelApi.Model);

        // Act
        _output.WriteLine($"开始请求模型 {config.ModelApi.Model}，使用文件接口...");
        var watch = System.Diagnostics.Stopwatch.StartNew();
        
        // 直接调用接受文件的接口
        var response = await client.AskWithAudioFileAsync(config.ModelApi.Model, prompt, testAudioPath);
        
        watch.Stop();

        // Assert
        _output.WriteLine("\n=== 模型返回结果 ===");
        _output.WriteLine(response);
        _output.WriteLine($"\n耗时: {watch.ElapsedMilliseconds} ms");

        Assert.False(string.IsNullOrWhiteSpace(response));
    }
    [Fact]
    public async Task Test_Audio_Understanding_With_File_Stream()
    {
        var yamlContent = await File.ReadAllTextAsync("config.yaml");
        var deserializer = new DeserializerBuilder().WithNamingConvention(PascalCaseNamingConvention.Instance).Build();
        var config = deserializer.Deserialize<AppSettings>(yamlContent);
        
        // Arrange
        const string prompt = "你从音频中听到了什么?";
        const string testAudioPath = "/mnt/d/temp/a.wav"; 
        Assert.True(File.Exists(testAudioPath), $"测试音频文件丢失: {testAudioPath}");

        using var client = new OmniLlmClient(config.ModelApi.Endpoint, config.ModelApi.LlmKey, config.ModelApi.Model);

        _output.WriteLine($"开始请求模型 {config.ModelApi.Model}，使用流式文件接口...");
        
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var fullReply = new StringBuilder();
        
        bool isFirstToken = true;
        long ttfb = 0; // Time To First Token

        // Act
        _output.WriteLine("\n=== 模型流式返回结果 ===");
        
        // 获取异步流
        var responseStream = client.AskWithAudioFileStreamAsync(config.ModelApi.Model, prompt, testAudioPath);

        // 像吃流水线上的糖果一样，来一颗吃一颗
        await foreach (var chunk in responseStream)
        {
            if (isFirstToken)
            {
                ttfb = watch.ElapsedMilliseconds;
                _output.WriteLine($"\n[首字响应时间 TTFB: {ttfb} ms]\n");
                isFirstToken = false;
            }
            
            // 实时打印每一个片段 (xUnit 的 _output.Write 不会自动换行，完美模拟打字机)
            _output.WriteLine(chunk); 
            fullReply.Append(chunk);
        }
        
        watch.Stop();

        // Assert
        _output.WriteLine($"\n\n=== 统计信息 ===");
        _output.WriteLine($"首字延迟: {ttfb} ms");
        _output.WriteLine($"总计耗时: {watch.ElapsedMilliseconds} ms");

        var finalResponse = fullReply.ToString();
        Assert.False(string.IsNullOrWhiteSpace(finalResponse), "模型返回的流式内容为空！");
    }
}