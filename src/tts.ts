const TS_FRAME_SAMPLES = 960; // 20ms @ 48kHz
const TS_FRAME_BYTES = TS_FRAME_SAMPLES * 2; // s16 mono

export interface AzureTtsConfig {
  endpoint?: string;
  apiKey?: string;
  voice?: string;
  outputFormat?: 'raw-48khz-16bit-mono-pcm' | 'riff-48khz-16bit-mono-pcm';
  sentenceFlushMs?: number;
  maxBufferedChars?: number;
  requestTimeoutMs?: number;
  xmlLang?: string;
}

export interface TtsStreamStats {
  queuedSegments: number;
  generatedFrames: number;
  droppedChars: number;
}

export interface TtsStreamSession {
  pushText(delta: string): void;
  endInput(): Promise<void>;
  abort(reason?: string): void;
  readFrames(): AsyncGenerator<Buffer, void, unknown>;
  stats(): TtsStreamStats;
}

const DEFAULT_TTS_CONFIG: Required<AzureTtsConfig> = {
  endpoint: '',
  apiKey: '',
  voice: 'en-US-AvaMultilingualNeural',
  outputFormat: 'raw-48khz-16bit-mono-pcm',
  sentenceFlushMs: 300,
  maxBufferedChars: 220,
  requestTimeoutMs: 30_000,
  xmlLang: 'en-US',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalizeEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Missing AZURE_ENDPOINT');
  if (base.endsWith('/cognitiveservices/v1')) return base;
  return `${base}/cognitiveservices/v1`;
}

function trimSegment(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isSentenceBoundary(char: string): boolean {
  return /[。！？!?.,，；;:\n]/.test(char);
}

class AsyncFrameQueue {
  private items: Buffer[] = [];
  private resolvers: Array<(value: Buffer | null) => void> = [];
  private ended = false;
  private failure: Error | null = null;

  push(item: Buffer): void {
    if (this.ended || this.failure) return;
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(null);
    }
  }

  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(null);
    }
  }

  private async shift(): Promise<Buffer | null> {
    if (this.failure) {
      throw this.failure;
    }
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.ended) {
      return null;
    }
    return new Promise<Buffer | null>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  async *drain(): AsyncGenerator<Buffer, void, unknown> {
    while (true) {
      const item = await this.shift();
      if (item == null) {
        if (this.failure) throw this.failure;
        return;
      }
      yield item;
    }
  }
}

class AzureTtsStreamSessionImpl implements TtsStreamSession {
  private readonly cfg: Required<AzureTtsConfig>;
  private readonly endpointUrl: string;
  private readonly frameQueue = new AsyncFrameQueue();
  private readonly activeControllers = new Set<AbortController>();

  private textBuffer = '';
  private segmentQueue: string[] = [];
  private processing = false;
  private inputEnded = false;
  private ended = false;
  private aborted = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pcmCarry = Buffer.alloc(0);
  private generatedFrames = 0;
  private droppedChars = 0;

  constructor(config: AzureTtsConfig = {}) {
    this.cfg = {
      ...DEFAULT_TTS_CONFIG,
      ...config,
      endpoint: config.endpoint ?? process.env.AZURE_ENDPOINT ?? '',
      apiKey: config.apiKey ?? process.env.AZURE_APIKEY ?? '',
    };
    if (!this.cfg.apiKey) throw new Error('Missing AZURE_APIKEY');
    this.endpointUrl = normalizeEndpoint(this.cfg.endpoint);
  }

  stats(): TtsStreamStats {
    return {
      queuedSegments: this.segmentQueue.length,
      generatedFrames: this.generatedFrames,
      droppedChars: this.droppedChars,
    };
  }

  pushText(delta: string): void {
    if (this.aborted || this.ended || this.inputEnded) return;
    const text = delta ?? '';
    if (!text) return;

    this.textBuffer += text;
    if (this.textBuffer.length > this.cfg.maxBufferedChars * 4) {
      const overflow = this.textBuffer.length - this.cfg.maxBufferedChars * 4;
      this.textBuffer = this.textBuffer.slice(overflow);
      this.droppedChars += overflow;
    }

    this.drainBufferBySentence();
    this.ensureFlushTimer();
    this.flushLongBuffer();
  }

  async endInput(): Promise<void> {
    if (this.aborted || this.ended) return;
    this.inputEnded = true;
    this.clearFlushTimer();
    this.flushAllBuffered();
    await this.waitForIdle();
    this.flushCarryAsLastFrame();
    this.ended = true;
    this.frameQueue.close();
  }

  abort(reason?: string): void {
    if (this.aborted || this.ended) return;
    this.aborted = true;
    this.clearFlushTimer();
    this.textBuffer = '';
    this.segmentQueue = [];
    for (const controller of this.activeControllers) {
      controller.abort(reason ?? 'TTS session aborted');
    }
    this.activeControllers.clear();
    this.frameQueue.close();
  }

  async *readFrames(): AsyncGenerator<Buffer, void, unknown> {
    yield* this.frameQueue.drain();
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.aborted || this.ended) return;
      this.flushLongBuffer();
    }, this.cfg.sentenceFlushMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer == null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private drainBufferBySentence(): void {
    while (this.textBuffer.length > 0) {
      let splitAt = -1;
      for (let i = 0; i < this.textBuffer.length; i += 1) {
        if (isSentenceBoundary(this.textBuffer[i])) {
          splitAt = i + 1;
          break;
        }
      }
      if (splitAt < 0) break;
      const segment = trimSegment(this.textBuffer.slice(0, splitAt));
      this.textBuffer = this.textBuffer.slice(splitAt);
      if (segment) {
        this.segmentQueue.push(segment);
      }
    }
    this.kickWorker();
  }

  private flushLongBuffer(): void {
    if (this.textBuffer.length === 0) return;
    if (this.textBuffer.length < this.cfg.maxBufferedChars && !this.inputEnded) return;
    const segment = trimSegment(this.textBuffer.slice(0, this.cfg.maxBufferedChars));
    this.textBuffer = this.textBuffer.slice(this.cfg.maxBufferedChars);
    if (segment) {
      this.segmentQueue.push(segment);
      this.kickWorker();
    }
    if (this.textBuffer.length > 0 && !this.inputEnded) {
      this.ensureFlushTimer();
    }
  }

  private flushAllBuffered(): void {
    this.drainBufferBySentence();
    while (this.textBuffer.length > 0) {
      const segment = trimSegment(this.textBuffer.slice(0, this.cfg.maxBufferedChars));
      this.textBuffer = this.textBuffer.slice(this.cfg.maxBufferedChars);
      if (segment) this.segmentQueue.push(segment);
    }
    this.kickWorker();
  }

  private kickWorker(): void {
    if (this.processing || this.aborted || this.ended) return;
    this.processing = true;
    void this.processSegments().finally(() => {
      this.processing = false;
    });
  }

  private async processSegments(): Promise<void> {
    while (!this.aborted && this.segmentQueue.length > 0) {
      const segment = this.segmentQueue.shift();
      if (!segment) continue;

      try {
        const pcm = await this.synthesizeSegmentWithRetry(segment, 1);
        this.pushPcmToFrames(pcm);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const wrapped = new Error(`[tts] segment synth failed: ${message}`);
        this.frameQueue.fail(wrapped);
        this.abort('segment synth failed');
        return;
      }
    }
  }

  private async waitForIdle(): Promise<void> {
    while (this.processing || this.segmentQueue.length > 0) {
      await sleep(10);
    }
  }

  private async synthesizeSegmentWithRetry(segment: string, retries: number): Promise<Buffer> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.synthesizeSegment(segment);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          await sleep(150 * (attempt + 1));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async synthesizeSegment(segment: string): Promise<Buffer> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort('TTS request timeout'), this.cfg.requestTimeoutMs);

    try {
      const ssml = `<speak version=\"1.0\" xml:lang=\"${escapeXml(this.cfg.xmlLang)}\"><voice name=\"${escapeXml(this.cfg.voice)}\">${escapeXml(segment)}</voice></speak>`;
      let response: Response;
      try {
        response = await fetch(this.endpointUrl, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.cfg.apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': this.cfg.outputFormat,
            'User-Agent': 'ts-ai-bot-azure-tts',
          },
          body: ssml,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error('Azure TTS request timeout');
        }
        throw err;
      }

      if (controller.signal.aborted) {
        throw new Error('Azure TTS request timeout');
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Azure TTS failed: ${response.status} ${response.statusText} - ${text}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (this.cfg.outputFormat === 'riff-48khz-16bit-mono-pcm') {
        if (bytes.length <= 44) return Buffer.alloc(0);
        return bytes.subarray(44);
      }
      return bytes;
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private pushPcmToFrames(chunk: Buffer): void {
    if (!chunk.length) return;
    let buf = this.pcmCarry.length ? Buffer.concat([this.pcmCarry, chunk]) : chunk;

    while (buf.length >= TS_FRAME_BYTES) {
      const frame = Buffer.from(buf.subarray(0, TS_FRAME_BYTES));
      this.frameQueue.push(frame);
      this.generatedFrames += 1;
      buf = buf.subarray(TS_FRAME_BYTES);
    }
    this.pcmCarry = Buffer.from(buf);
  }

  private flushCarryAsLastFrame(): void {
    if (this.pcmCarry.length === 0) return;
    const padded = Buffer.alloc(TS_FRAME_BYTES);
    this.pcmCarry.copy(padded, 0);
    this.frameQueue.push(padded);
    this.generatedFrames += 1;
    this.pcmCarry = Buffer.alloc(0);
  }
}

export function createAzureTtsStreamSession(config: AzureTtsConfig = {}): TtsStreamSession {
  return new AzureTtsStreamSessionImpl(config);
}
