const TS_FRAME_SAMPLES = 960; // 20ms @ 48kHz
const TS_FRAME_BYTES = TS_FRAME_SAMPLES * 2; // s16 mono

export interface AzureTtsConfig {
	endpoint?: string;
	apiKey?: string;
	voice?: string;
	outputFormat?: 'raw-48khz-16bit-mono-pcm' | 'riff-48khz-16bit-mono-pcm';
	sentenceFlushMs?: number;
	maxBufferedChars?: number;
	maxConcurrentRequests?: number;
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
	voice: 'zh-CN-XiaoxiaoNeural',
	outputFormat: 'raw-48khz-16bit-mono-pcm',
	sentenceFlushMs: 180,
	maxBufferedChars: 900,
	maxConcurrentRequests: 5,
	requestTimeoutMs: 30_000,
	xmlLang: 'zh-CN',
};

interface QueuedSegment {
  // 按进入队列顺序分配的递增 id，用于并发完成后的有序回放。
  id: number;
  text: string;
}

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
	private segmentQueue: QueuedSegment[] = [];
	private processing = false;
	private inputEnded = false;
	private ended = false;
	private aborted = false;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pcmCarry = Buffer.alloc(0);
	private generatedFrames = 0;
  private droppedChars = 0;
  // 下一个待分配的分段 id。
  private nextSegmentId = 0;
  // 下一个应该输出到音频帧队列的分段 id（保证朗读顺序不乱）。
  private nextEmitSegmentId = 1;
  // 并发请求先完成的分段会暂存在这里，等待按 id 顺序刷出。
  private readonly pendingPcmBySegmentId = new Map<number, Buffer>();

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
				this.enqueueSegment(segment);
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
			this.enqueueSegment(segment);
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
			if (segment) this.enqueueSegment(segment);
		}
		this.kickWorker();
	}

	private enqueueSegment(text: string): void {
		this.nextSegmentId += 1;
		this.segmentQueue.push({ id: this.nextSegmentId, text });
	}

	private kickWorker(): void {
		if (this.processing || this.aborted || this.ended) return;
		this.processing = true;
		void this.processSegments().finally(() => {
			this.processing = false;
		});
	}

  private async processSegments(): Promise<void> {
    // 受控并发：同时最多发起 maxConcurrent 个 Azure TTS 请求。
    const maxConcurrent = Math.max(1, this.cfg.maxConcurrentRequests);
    const inFlight = new Map<number, Promise<void>>();

		while (!this.aborted) {
			while (!this.aborted && inFlight.size < maxConcurrent && this.segmentQueue.length > 0) {
				const segment = this.segmentQueue.shift();
				if (!segment) break;

        const task = this.synthesizeSegmentWithRetry(segment.text, 1)
          .then((pcm) => {
            // 并发完成可能乱序，先缓存，再由 flushReadySegmentsInOrder 按序输出。
            this.pendingPcmBySegmentId.set(segment.id, pcm);
            this.flushReadySegmentsInOrder();
          })
					.catch((err) => {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(`[tts] segment synth failed: ${message}`);
					})
					.finally(() => {
						inFlight.delete(segment.id);
					});
				inFlight.set(segment.id, task);
			}

			if (inFlight.size === 0) {
				if (this.segmentQueue.length === 0) break;
				continue;
			}

      try {
        // 等任意一个并发任务完成，以便持续补位提交后续分段。
        await Promise.race(inFlight.values());
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
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
			return this.decodePcm(bytes);
		} finally {
			clearTimeout(timeout);
			this.activeControllers.delete(controller);
		}
	}

	private decodePcm(bytes: Buffer): Buffer {
		if (!bytes.length) return Buffer.alloc(0);
		if (this.cfg.outputFormat === 'riff-48khz-16bit-mono-pcm') {
			if (bytes.length <= 44) return Buffer.alloc(0);
			return bytes.subarray(44);
		}
		return bytes;
	}

  private flushReadySegmentsInOrder(): void {
    // 只有当前一个分段已输出后，才允许输出下一个，确保音频顺序与文本一致。
    while (true) {
      const pcm = this.pendingPcmBySegmentId.get(this.nextEmitSegmentId);
      if (!pcm) break;
			this.pendingPcmBySegmentId.delete(this.nextEmitSegmentId);
			this.pushPcmToFrames(pcm);
			this.nextEmitSegmentId += 1;
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
