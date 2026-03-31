namespace TS_AI_Bot;

public class AppSettings
{
    public required PicovoiceConfig Picovoice { get; set; }
    public required TeamSpeakConfig TeamSpeak { get; set; }
    public required ModelApiConfig ModelApi { get; set; }
    public required AzureTtsConfig AzureTts { get; set; }
    public required TextsConfig Texts { get; set; }
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
}

public class AzureTtsConfig
{
    public required string Endpoint { get;  set; }
    public required string Key { get; set; }
    
    public required int MaxTextLength { get; set; }
    public required int MaxConcurrency { get; set; }
    public required float Speed { get; set; }
}

public class TextsConfig
{
   public required string HelloAudio {get; set; } 
   public required string UserPrompts { get; set; }
   public required string ResponseAudio { get; set; }
}
