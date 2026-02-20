export interface AudioInferenceOptions {
  apiKey?: string;
  model?: string;
  format?: 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'pcm16';
  prompt?: string;
  reasoningEnabled?: boolean;
}

export interface OpenRouterAssistantMessage {
  role: 'assistant';
  content: unknown;
  reasoning_details?: unknown;
  [key: string]: unknown;
}

export interface AudioInferenceResult {
  message: OpenRouterAssistantMessage;
  raw: unknown;
}

export interface AudioInferenceStreamOptions extends AudioInferenceOptions {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

/**
 * Wrap PCM16 little-endian mono/stereo data into a WAV container.
 */
export function pcm16leToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize;

  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Run multimodal inference on OpenRouter with audio input.
 * Uses the chat/completions endpoint and returns the assistant message object.
 */
export async function inferFromAudio(
  audio: Buffer | string,
  options: AudioInferenceOptions = {},
): Promise<AudioInferenceResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  const model = options.model ?? 'google/gemini-3-flash-preview';
  const format = options.format ?? 'wav';
  const prompt = options.prompt ?? 'Please understand this audio and answer concisely.';
  const reasoningEnabled = options.reasoningEnabled ?? true;
  const audioBase64 = Buffer.isBuffer(audio) ? audio.toString('base64') : audio;

  // OpenRouter chat/completions multimodal content: text + input_audio
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'input_audio',
            input_audio: {
              data: audioBase64,
              format,
            },
          },
        ],
      },
    ],
    reasoning: { enabled: reasoningEnabled },
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} - ${errText}`);
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: OpenRouterAssistantMessage }>;
  };
  const message = result.choices?.[0]?.message;
  if (!message) {
    throw new Error('OpenRouter response missing choices[0].message');
  }

  return { message, raw: result };
}

function extractDeltaText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: unknown }).text ?? '');
      }
      return '';
    })
    .join('');
}

/**
 * Stream multimodal inference from OpenRouter with audio input.
 * Note: audio must still be fully uploaded first; streaming lowers decode/generation latency.
 */
export async function inferFromAudioStream(
  audio: Buffer | string,
  options: AudioInferenceStreamOptions = {},
): Promise<AudioInferenceResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  const model = options.model ?? 'google/gemini-3-flash-preview';
  const format = options.format ?? 'wav';
  const prompt = options.prompt ?? 'Please understand this audio and answer concisely.';
  const reasoningEnabled = options.reasoningEnabled ?? true;
  const audioBase64 = Buffer.isBuffer(audio) ? audio.toString('base64') : audio;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format,
              },
            },
          ],
        },
      ],
      reasoning: { enabled: reasoningEnabled },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter stream request failed: ${response.status} ${response.statusText} - ${errText}`);
  }
  if (!response.body) {
    throw new Error('OpenRouter stream response has no body');
  }

  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let buffer = '';

  let fullText = '';
  let fullReasoning = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lineBreak = buffer.indexOf('\n');
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).trim();
      buffer = buffer.slice(lineBreak + 1);
      lineBreak = buffer.indexOf('\n');

      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: unknown;
            reasoning_details?: unknown;
          };
          message?: OpenRouterAssistantMessage;
        }>;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const textDelta = extractDeltaText(delta.content);
        if (textDelta) {
          fullText += textDelta;
          options.onTextDelta?.(textDelta);
        }

        const reasoningDelta = extractDeltaText(delta.reasoning_details);
        if (reasoningDelta) {
          fullReasoning += reasoningDelta;
          options.onReasoningDelta?.(reasoningDelta);
        }
      }
    }
  }

  const message: OpenRouterAssistantMessage = {
    role: 'assistant',
    content: fullText,
    reasoning_details: fullReasoning || undefined,
  };
  return { message, raw: { content: fullText, reasoning_details: fullReasoning } };
}
