using System.Collections.Concurrent;
using System.Diagnostics;
using Serilog;
using TSLib.Audio;
namespace TS_AI_Bot;

public class WakeWordReceiver : IAudioPassiveConsumer, IDisposable
{
    public bool Active => true;
    public event Action<ushort, byte[]>? OnAudioRecorded;
    public event Action<ushort>? OnWakeWordDetected;
    public event Action<ushort>? OnNewUser;
    
    private readonly CancellationTokenSource _cts = new();
    
    private readonly ConcurrentDictionary<ushort, WakeWordDetector>  _detectors = new();
    private readonly string? _accessKey;

    private bool _isProcessing;
    
    private readonly object _lockObj = new object();
    private ushort? _activeSpeakerId; // 当前正在录音的用户
    private MemoryStream? _audioBuffer;       // 存音频的内存流
    private Stopwatch? _silenceTimer;         // 沉默计时器

    public WakeWordReceiver(string? accessKey = null)
    {
       _accessKey = accessKey; 
       
       Task.Run(MonitorSilenceAsync);
    }

    public void Write(Span<byte> data, Meta? meta)
    {
        if (meta is null) return;
        ushort senderId = meta.In.Sender.Value;

        lock (_lockObj)
        {
            if (_activeSpeakerId != null && senderId == _activeSpeakerId.Value)
            {
                _audioBuffer?.Write(data); 
                _silenceTimer?.Restart();
                return; 
            }

            var detector = _detectors.GetOrAdd(senderId, _=>
            {
                var newDetector = new WakeWordDetector(senderId, _accessKey);
                newDetector.OnWaked += HandleUserWaked;
                OnNewUser?.Invoke(senderId);
                return newDetector;
            });
            
            // 保持水管畅通，消耗掉废弃的唤醒词
            detector.FeedAudio(data);
        }
    }

    public void ResumeListening()
    {
        lock (_lockObj)
        {
            _isProcessing = false;
            Log.Information("Resume listening.");
        }
    }

    private async Task MonitorSilenceAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            await Task.Delay(100);

            byte[]? recordedData = null;
            ushort? finishedUserId = null;

            lock (_lockObj)
            {
                if (_activeSpeakerId != null && _silenceTimer?.ElapsedMilliseconds > 2500)
                {
                    Log.Information("Stop listening.");
                    
                    _isProcessing = true;
                    recordedData = _audioBuffer?.ToArray();
                    finishedUserId = _activeSpeakerId;
                    
                    _activeSpeakerId = null;
                    _audioBuffer?.Dispose();
                    _audioBuffer = null;
                    _silenceTimer.Stop();
                    _silenceTimer = null;
                }
            }

            if (recordedData != null && finishedUserId != null)
            {
                OnAudioRecorded?.Invoke(finishedUserId.Value, recordedData);
            }
        }
    }

    private async void HandleUserWaked(ushort wakedUserId)
    {
        try
        {
            bool isFirstWake;
            
            lock (_lockObj)
            {
                if (_activeSpeakerId != null || _isProcessing) return;

                // 1. 抢麦成功！立刻开启全局处理锁。
                _isProcessing = true; 
                isFirstWake = true;
            }

            if (!isFirstWake) return;
            // 2. 触发事件，通知主程序去查询名字并播放 TTS
            OnWakeWordDetected?.Invoke(wakedUserId);

            await Task.Delay(2500);

            lock (_lockObj)
            {
                _activeSpeakerId = wakedUserId;
                _audioBuffer = new MemoryStream();
                _silenceTimer = Stopwatch.StartNew();
                    
                // 解除全局处理锁
                _isProcessing = false; 
            }
                
            Log.Information("Start listening.");
        }
        catch (Exception ex)
        {
            // 拦截所有致命异常，保住整个进程不崩溃
            Log.Error("WakeWordDetector Exception: {Ex}", ex);
            
            lock (_lockObj)
            {
                _isProcessing = false;
                _activeSpeakerId = null;
            }
        }
    }
    public void Dispose()
    {
        _cts.Cancel();
        _cts.Dispose();
        foreach (var detector in _detectors.Values)
        {
            detector.Dispose();
        }
        _detectors.Clear();
        _audioBuffer?.Dispose();
    }
}