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

        using var client = new OmniLlmClient(config.ModelApi.Endpoint, config.ModelApi.LlmKey);

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
}