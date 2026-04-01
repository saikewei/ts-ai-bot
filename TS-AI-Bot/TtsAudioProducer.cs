using System.Diagnostics;
using Serilog;
using TSLib.Audio;

namespace TS_AI_Bot;

public class TtsAudioProducer : IAudioActiveProducer
{
    // 实现 IAudioActiveProducer 接口要求的属性：指向下级流水线
    public IAudioPassiveConsumer? OutStream { get; set; }

    /// <summary>
    /// 播放 TTS 生成的 48kHz 单声道 PCM 数据
    /// </summary>
    /// <param name="monoPcmData">Azure 返回的音频裸流</param>
    /// <param name="cancellationToken">用于中途打断说话的令牌（选填）</param>
    public async Task PlayTtsAsync(byte[] monoPcmData, CancellationToken cancellationToken = default)
    {
        // 如果管道没接好，或者下级消费者处于离线状态，就直接返回
        if (OutStream == null || !OutStream.Active)
        {
            Log.Warning("TTS not ready!");
            return;
        }

        // 1. 单声道转双声道 (复制一遍数据给另一只耳朵)
        byte[] stereoPcmData = ConvertMonoToStereo(monoPcmData);

        // 2. 准备切片：20ms 的 48kHz 16-bit 双声道音频 = 3840 字节
        // 计算公式: 48000 采样/秒 * 0.02 秒 * 2 通道 * 2 字节/采样 = 3840
        int frameSize = 3840; 
        int offset = 0;
        int frameCount = 0;

        // 启动高精度计时器
        var stopwatch = Stopwatch.StartNew();

        Log.Debug("Streaming audio.");

        // 3. 核心推流循环
        while (offset < stereoPcmData.Length && !cancellationToken.IsCancellationRequested)
        {
            // 切割出当前这一帧的数据（最后一块可能不足 3840 字节）
            int bytesToRead = Math.Min(frameSize, stereoPcmData.Length - offset);

            // 推给下级消费者（比如 EncoderPipe）。对外发声不需要特殊的 Meta 信息，传 null 即可
            OutStream.Write(stereoPcmData.AsSpan(offset, bytesToRead), null);

            offset += bytesToRead;
            frameCount++;

            // 4. 节拍器：计算应该等待的时间，模拟真实的 20ms 发音耗时
            int expectedTime = frameCount * 20;
            int delayTime = expectedTime - (int)stopwatch.ElapsedMilliseconds;

            if (delayTime > 0)
            {
                try
                {
                    await Task.Delay(delayTime, cancellationToken);
                }
                catch (TaskCanceledException)
                {
                    break;
                }
            }
        }
        
        stopwatch.Stop();
        // Console.WriteLine("[TTS播放器] 语音推流结束！");
    }

    /// <summary>
    /// 辅助方法：将单声道 PCM 转换为双声道 PCM
    /// </summary>
    private byte[] ConvertMonoToStereo(byte[] monoData)
    {
        byte[] stereoData = new byte[monoData.Length * 2];
        for (int i = 0, j = 0; i < monoData.Length; i += 2, j += 4)
        {
            // 左声道 (前2个字节)
            stereoData[j] = monoData[i];
            stereoData[j + 1] = monoData[i + 1];
            // 右声道 (后2个字节，直接复制左声道)
            stereoData[j + 2] = monoData[i];
            stereoData[j + 3] = monoData[i + 1];
        }
        return stereoData;
    }
    /// <summary>
    /// 在内存中纯数学合成一段“滴”声的 48kHz 16-bit 单声道 PCM 数据
    /// </summary>
    /// <param name="frequency">声音频率（Hz），800-1000Hz是标准的提示音</param>
    /// <param name="durationMs">声音持续时间（毫秒）</param>
    /// <param name="amplitude">音量大小（最高32767，建议10000左右不要太刺耳）</param>
    /// <returns>可以直接播放的 PCM 字节流</returns>
    public static byte[] GenerateBeepPcm(int frequency = 800, int durationMs = 150, short amplitude = 10000)
    {
        int sampleRate = 48000; // TeamSpeak 的标准采样率
        int totalSamples = (sampleRate * durationMs) / 1000; // 总采样点数
        byte[] pcmData = new byte[totalSamples * 2]; // 16-bit 音频每个采样占 2 个字节

        for (int i = 0; i < totalSamples; i++)
        {
            // 当前时间 t = 当前采样索引 / 采样率
            double time = (double)i / sampleRate;
            
            // 正弦波发声核心算法: y(t) = A * sin(2 * PI * f * t)
            short sampleValue = (short)(amplitude * Math.Sin(2 * Math.PI * frequency * time));

            // 将 16位的 short 拆解为 2个 byte (小端序) 存入数组
            pcmData[i * 2] = (byte)(sampleValue & 0xFF);
            pcmData[i * 2 + 1] = (byte)((sampleValue >> 8) & 0xFF);
        }

        return pcmData;
    }
}