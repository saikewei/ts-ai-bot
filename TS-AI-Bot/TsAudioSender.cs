using TSLib;
using TSLib.Audio;
using TSLib.Full;

namespace TS_AI_Bot;

public class TsAudioSender : IAudioPassiveConsumer
{
    private readonly TsFullClient _client;

    public TsAudioSender(TsFullClient client)
    {
        this._client = client;
    }

    public bool Active => _client.Connected;

    public void Write(Span<byte> data, Meta? meta)
    {
        if (!_client.Connected) return;
        Codec codec = meta?.Codec ?? Codec.OpusVoice;
        _client.SendAudio(data, codec);
    }
}