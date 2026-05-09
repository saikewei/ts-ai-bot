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
    /// 将 24000Hz 16-bit 单声道数据转换为 48000Hz 16-bit 单声道
    /// </summary>
    public static byte[] Resample24KTo48K(byte[]? input)
    {
        if (input == null || input.Length == 0) return Array.Empty<byte>();

        // 因为采样率翻倍，输出长度也是输入的 2 倍
        byte[] output = new byte[input.Length * 2];
        
        // 将 byte 数组视为 short (16-bit) 数组进行处理
        ReadOnlySpan<short> source = MemoryMarshal.Cast<byte, short>(input);
        Span<short> target = MemoryMarshal.Cast<byte, short>(output);

        for (int i = 0; i < source.Length; i++)
        {
            // 1. 原样复制当前采样点
            target[i * 2] = source[i];

            // 2. 插入中间点
            if (i < source.Length - 1)
            {
                // 计算当前点和下一个点的平均值（线性插值）
                target[i * 2 + 1] = (short)((source[i] + source[i + 1]) / 2);
            }
            else
            {
                // 最后一个点后面没有数据了，直接复制最后一个点
                target[i * 2 + 1] = source[i];
            }
        }

        return output;
    }
}