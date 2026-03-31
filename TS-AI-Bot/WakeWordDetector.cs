using System.Runtime.InteropServices;
using System.Threading.Channels;
using NanoWakeWord;
using Pv;
using Serilog;

namespace TS_AI_Bot;

public class WakeWordDetector : IDisposable
{
    private ushort UserId { get; }
    private readonly Porcupine? _porcupineHandle;
    private readonly WakeWordRuntime?  _nanoWakeWordRuntime;

    public event Action<ushort>? OnWaked;

    private readonly List<BuiltInKeyword> _keyword = [BuiltInKeyword.HEY_GOOGLE];
    
    private readonly CancellationTokenSource _cts;
    private readonly Channel<short> _audioBuffer;
    public WakeWordDetector(ushort userId, string? accessKey = null)
    {
        UserId = userId;
        _audioBuffer = Channel.CreateUnbounded<short>();
        _cts = new CancellationTokenSource();
        if (accessKey != null)
        {
            ArgumentNullException.ThrowIfNull(accessKey);
            _porcupineHandle = Porcupine.FromBuiltInKeywords(accessKey, _keyword);
        }
        else
        {
            _nanoWakeWordRuntime = new WakeWordRuntime(new WakeWordRuntimeConfig
            {
                DebugAction = (model,
                    probability,
                    detected) =>
                {
                    if (detected)
                        Log.Debug("Detected! Model: {Model}, Probability: {Probability}", model, probability);
                },
                WakeWords =
                [
                    new WakeWordConfig
                    {
                        Model = "alexa_v0.1",
                        Threshold = 0.9f
                    }
                ]
            });
        }

        Task.Run(DetectLoopAsync);
    }

    public void FeedAudio(Span<byte> stereo48KData)
    {
        var shorts = MemoryMarshal.Cast<byte, short>(stereo48KData);

        for (var i = 0; i < shorts.Length; i += 6)
        {
            _audioBuffer.Writer.TryWrite(shorts[i]);
        }
    }

    private async Task DetectLoopAsync()
    {
        try
        {
            if (_porcupineHandle != null)
            {
                var frameLength = _porcupineHandle.FrameLength;
                var frameBuffer = new short[frameLength];
                var bufferIndex = 0;

                await foreach (var sample in _audioBuffer.Reader.ReadAllAsync(_cts.Token))
                {
                    frameBuffer[bufferIndex++] = sample;

                    if (bufferIndex == frameLength)
                    {
                        var keywordIndex = _porcupineHandle.Process(frameBuffer);
                        if (keywordIndex >= 0)
                        {
                            Log.Information("{UserId} waked me up!",  UserId);
                            OnWaked?.Invoke(UserId);
                        }
                        else
                        {
                            // Console.WriteLine($"{DateTime.Now.ToLongTimeString()}: {UserId} index: {keywordIndex}!");
                        }
                        bufferIndex = 0;
                    }
                }
            }
            else if (_nanoWakeWordRuntime != null)
            {
                const int frameLength = 512;
                var frameBuffer = new short[frameLength];
                var bufferIndex = 0;

                await foreach (var sample in _audioBuffer.Reader.ReadAllAsync(_cts.Token))
                {
                    frameBuffer[bufferIndex++] = sample;
                    if (bufferIndex == frameLength)
                    {
                        var result = _nanoWakeWordRuntime.Process(frameBuffer);
                        if (result >= 0)
                        {
                            Log.Information("{UserId} waked me up!",  UserId);
                            OnWaked?.Invoke(UserId);
                        }
                        bufferIndex = 0;
                    }
                }
            }
            else
            {
                throw new Exception("all engine is null");
            }
                
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Error("WakeWordDetector Exception: {Ex}", ex);
        }
    }
    
    public void Dispose()
    {
        _cts.Cancel();
        _audioBuffer.Writer.TryComplete();
        _porcupineHandle?.Dispose();
        _nanoWakeWordRuntime?.Dispose();
        _cts.Dispose();
    }
}
