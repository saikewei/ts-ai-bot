using System.Diagnostics;
using Serilog;
using TSLib;
using TSLib.Audio;
using TSLib.Full;
using TSLib.Scheduler;

namespace TS_AI_Bot;

public static class AudioPlayer
{
    public static async Task PlayMusicWithPipeAsync(string filePath, TsFullClient client,
        DedicatedTaskScheduler scheduler)
    {
        Log.Information("Playing music from {Path}", filePath);

        using var encoderPipe = new EncoderPipe(Codec.OpusMusic);
        var volumePipe = new VolumePipe();
        var audioSender = new TsAudioSender(client);

        volumePipe.Volume = 0.02f;
        
        encoderPipe.OutStream = audioSender;
        volumePipe.OutStream = encoderPipe;
        
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = $"-loglevel error -i \"{filePath}\" -f s16le -acodec pcm_s16le -ac 2 -ar 48000 pipe:1",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        process.Start();
        
        var stream = process.StandardOutput.BaseStream;

        var bytesPerFrame = 3840;
        var pcmBuffer = new byte[bytesPerFrame];

        var stopwatch = Stopwatch.StartNew();
        var frameCount = 0;
        
        int bytesRead;
        while ((bytesRead = await stream.ReadAsync(pcmBuffer, 0, bytesPerFrame)) > 0)
        {
            if (bytesRead < bytesPerFrame)
            {
                Array.Clear(pcmBuffer, bytesRead, bytesPerFrame - bytesRead);
            }
            
            await scheduler.Invoke(() => 
            {
                // 传 null 的 Meta，因为 Pipe 会自动帮我们生成并带上 Codec
                volumePipe.Write(pcmBuffer, null);
            });

            // 节奏控制：严格保持 20ms 发送一帧，防止断音或快放
            frameCount++;
            long targetTimeMs = frameCount * 20;
            int waitTimeMs = (int)(targetTimeMs - stopwatch.ElapsedMilliseconds);

            if (waitTimeMs > 0)
            {
                await Task.Delay(waitTimeMs);
            }
        }
    }
}