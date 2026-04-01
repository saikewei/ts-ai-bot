using TS_AI_Bot;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;
using Serilog;

// 1. 配置日志
Log.Logger = new LoggerConfiguration().MinimumLevel.Debug().WriteTo
    .Console(outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
    .CreateLogger();

// 2. 读取配置
var yamlContent = File.ReadAllText("config.yaml");
var deserializer = new DeserializerBuilder().WithNamingConvention(PascalCaseNamingConvention.Instance).Build();
var config = deserializer.Deserialize<AppSettings>(yamlContent);
Log.Information("Config loaded!");

// 3. 实例化机器人并启动
var bot = new TsBot(config);
await bot.StartAsync();

// 4. 挂载系统退出信号 
var shutdownTcs = new TaskCompletionSource();
var cleanupFinishedTcs = new TaskCompletionSource();

AppDomain.CurrentDomain.ProcessExit += (_, _) =>
{
    Log.Information("Shutting down (ProcessExit)...");
    shutdownTcs.TrySetResult();
    cleanupFinishedTcs.Task.Wait(); 
};

Console.CancelKeyPress += (_, e) =>
{
    Log.Information("Shutting down (Ctrl+C)...");
    e.Cancel = true;
    shutdownTcs.TrySetResult();
};

// 5. 将主线程挂起，保持程序运行
await shutdownTcs.Task;

// 6. 收到退出信号，开始清理资源
await bot.DisposeAsync();

cleanupFinishedTcs.TrySetResult();