using System.Runtime.InteropServices;
using System.Text;

namespace TS_AI_Bot;

public static class AudioUtils
{
    public static byte[] WrapPcmToWav(byte[] pcmData, int sampleRate, short channels, short bitsPerSample)
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
    /// <summary>
    /// 使用 4点三次样条插值 (Cubic Spline) 将 24000Hz 提升至 48000Hz
    /// 音质远超线性插值，且无需启动 FFmpeg
    /// </summary>
    public static byte[] Resample24KTo48K(byte[]? input)
    {
        if (input == null || input.Length == 0) return Array.Empty<byte>();

        byte[] output = new byte[input.Length * 2];
        ReadOnlySpan<short> source = MemoryMarshal.Cast<byte, short>(input);
        Span<short> target = MemoryMarshal.Cast<byte, short>(output);

        for (int i = 0; i < source.Length; i++)
        {
            // 1. 偶数索引：保留原始点
            target[i * 2] = source[i];

            // 2. 奇数索引：插入高精度平滑点
            if (i < source.Length - 1)
            {
                // 取前后共 4 个参考点 (x0, x1, x2, x3)
                int x0 = i > 0 ? source[i - 1] : source[i];
                int x1 = source[i];
                int x2 = source[i + 1];
                int x3 = i < source.Length - 2 ? source[i + 2] : source[i + 1];

                // 2倍上采样专用的 Catmull-Rom FIR 滤波器整数公式
                // 结果 = (-x0 + 9*x1 + 9*x2 - x3) / 16
                int interpolated = (-x0 + 9 * x1 + 9 * x2 - x3) >> 4; 

                // 防溢出裁剪，写入目标数组
                target[i * 2 + 1] = (short)Math.Clamp(interpolated, short.MinValue, short.MaxValue);
            }
            else
            {
                // 结尾补齐
                target[i * 2 + 1] = source[i];
            }
        }

        return output;
    }
    /// <summary>
    /// 调整 16-bit PCM 音频的音量
    /// </summary>
    /// <param name="input">原始音频字节数组</param>
    /// <param name="multiplier">音量倍数。1.0 为原声，0.5 为减半，2.0 为翻倍</param>
    /// <returns>调整音量后的字节数组</returns>
    public static byte[] AdjustVolume(byte[]? input, float multiplier)
    {
        if (input == null || input.Length == 0) return Array.Empty<byte>();

        // 如果倍数接近 1.0，直接返回原数组以节省 CPU
        if (Math.Abs(multiplier - 1.0f) < 0.01f) return input;

        byte[] output = new byte[input.Length];
        
        ReadOnlySpan<short> source = MemoryMarshal.Cast<byte, short>(input);
        Span<short> target = MemoryMarshal.Cast<byte, short>(output);

        for (int i = 0; i < source.Length; i++)
        {
            // 1. 将 short 转换为 float 并乘以音量倍数
            float scaledValue = source[i] * multiplier;

            // 2. 核心：防止溢出！将结果限制在 16-bit 的安全范围内
            target[i] = (short)Math.Clamp(scaledValue, short.MinValue, short.MaxValue);
        }

        return output;
    }
}