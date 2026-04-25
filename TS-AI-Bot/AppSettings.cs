namespace TS_AI_Bot;

public class AppSettings
{
    public required PicovoiceConfig Picovoice { get; set; }
    public required TeamSpeakConfig TeamSpeak { get; set; }
    public required ModelApiConfig ModelApi { get; set; }
    public required TextsConfig Texts { get; set; }
    public required DoubaoTtsConfig DoubaoTts { get; set; }
}

// 对应 Picovoice 节点
public class PicovoiceConfig
{
    public required bool UsePico{get; set; }
    public required string AccessKey { get; set; }
    // public string Keyword { get; set; }
}

// 对应 TeamSpeak 节点
public class TeamSpeakConfig
{
    public required string Host { get; set; }
    public required string Username { get; set; }
    public required string ServerPassword { get; set; }
}

public class ModelApiConfig
{
    public required string LlmKey { get; set; }
    public required string Endpoint { get; set; }
    public required string Model { get; set; }
    public required int MaxContextTurns { get; set; }
}

public class TextsConfig
{
   public required string HelloAudio {get; set; } 
   public required string UserPrompts { get; set; }
   public required string ResponseAudio { get; set; }
}

public class DoubaoTtsConfig
{
    public required string AppId { get; set; }
    public required string AccessToken { get; set; }
    public required string Voice { get; set; }
    public required float Speed {get; set; }
}
