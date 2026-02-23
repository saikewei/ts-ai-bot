// This file is adapted from:
// https://github.com/dnavarrom/openwakeword_wasm/blob/main/src/WakeWordEngine.js
import * as ort from 'onnxruntime-web';
import * as path from 'node:path';

export const MODEL_FILE_MAP: Record<string, string> = {};

type WakeWordEvent =
    | 'ready'
    | 'speech-start'
    | 'speech-end'
    | 'detect'
    | 'error'
    | 'vad-result'
    | 'frame-result';
type EventHandler = (payload?: unknown) => void;

interface WakeWordEmitter {
    on(event: WakeWordEvent, handler: EventHandler): () => void;
    off(event: WakeWordEvent, handler: EventHandler): void;
    emit(event: WakeWordEvent, payload?: unknown): void;
}

interface CoreModelFiles {
    melspectrogram: string;
    embedding: string;
    vad: string;
}

interface WakeWordEngineOptions {
    keywords?: string[];
    modelFiles?: Record<string, string>;
    coreModelFiles?: Partial<CoreModelFiles>;
    baseModelPath?: string;
    frameSize?: number;
    sampleRate?: number;
    vadHangoverFrames?: number;
    detectionThreshold?: number;
    minConsecutiveDetections?: number;
    vadThreshold?: number;
    requireSpeechGate?: boolean;
    cooldownMs?: number;
    executionProviders?: string[];
    embeddingWindowSize?: number;
    debug?: boolean;
}

interface KeywordModelState {
    session: ort.InferenceSession;
    scores: number[];
    windowSize: number;
    history: Float32Array[];
    consecutiveHits: number;
}

interface WakeWordEngineConfig {
    keywords: string[];
    modelFiles: Record<string, string>;
    coreModelFiles: Partial<CoreModelFiles>;
    baseModelPath: string;
    frameSize: number;
    sampleRate: number;
    vadHangoverFrames: number;
    detectionThreshold: number;
    minConsecutiveDetections: number;
    vadThreshold: number;
    requireSpeechGate: boolean;
    cooldownMs: number;
    executionProviders: string[];
    embeddingWindowSize: number;
    debug: boolean;
}

const createEmitter = (): WakeWordEmitter => {
    const listeners = new Map<WakeWordEvent, Set<EventHandler>>();
    return {
        on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)?.add(handler);
            return () => this.off(event, handler);
        },
        off(event, handler) {
            listeners.get(event)?.delete(handler);
        },
        emit(event, payload) {
            const handlers = listeners.get(event);
            if (!handlers) return;
            for (const handler of Array.from(handlers)) handler(payload);
        }
    };
};

export class WakeWordEngine {
    private config: WakeWordEngineConfig;
    private _emitter: WakeWordEmitter;
    private _melBuffer: Float32Array[];
    private _activeKeywords: Set<string>;
    private _vadState: { h: ort.Tensor | null; c: ort.Tensor | null };
    private _isSpeechActive: boolean;
    private _vadHangover: number;
    private _isDetectionCoolingDown: boolean;
    private _loaded: boolean;

    private _melspecModel!: ort.InferenceSession;
    private _embeddingModel!: ort.InferenceSession;
    private _vadModel!: ort.InferenceSession;
    private _keywordModels: Record<string, KeywordModelState> = {};

    constructor({
        keywords = [],
        modelFiles = MODEL_FILE_MAP,
        coreModelFiles = {},
        baseModelPath = '/models',
        frameSize = 1280,
        sampleRate = 16000,
        vadHangoverFrames = 12,
        detectionThreshold = 0.5,
        minConsecutiveDetections = 1,
        vadThreshold = 0.5,
        requireSpeechGate = true,
        cooldownMs = 2000,
        executionProviders = ['wasm'],
        embeddingWindowSize = 16,
        debug = false
    }: WakeWordEngineOptions = {}) {
        this.config = {
            keywords,
            modelFiles,
            coreModelFiles,
            baseModelPath,
            frameSize,
            sampleRate,
            vadHangoverFrames,
            detectionThreshold,
            minConsecutiveDetections,
            vadThreshold,
            requireSpeechGate,
            cooldownMs,
            executionProviders,
            embeddingWindowSize,
            debug
        };
        this._emitter = createEmitter();
        this._melBuffer = [];
        this._activeKeywords = new Set(keywords);
        this._vadState = { h: null, c: null };
        this._isSpeechActive = false;
        this._vadHangover = 0;
        this._isDetectionCoolingDown = false;
        this._loaded = false;
    }

    on(event: WakeWordEvent, handler: EventHandler): () => void {
        return this._emitter.on(event, handler);
    }

    async load(): Promise<void> {
        if (this._loaded) return;
        if (!Array.isArray(this.config.keywords) || this.config.keywords.length === 0) {
            throw new Error('No keywords configured. Please provide `keywords` and `modelFiles` when creating WakeWordEngine.');
        }
        const { melspectrogram, embedding, vad } = this.config.coreModelFiles || {};
        if (!melspectrogram || !embedding || !vad) {
            throw new Error('Missing core models. Please provide `coreModelFiles: { melspectrogram, embedding, vad }`.');
        }
        const sessionOptions: ort.InferenceSession.SessionOptions = {
            executionProviders: this.config.executionProviders
        };
        const resolver = (file: string): string => this._resolveLocalModelPath(file);
        this._debug('Loading core models from local files with options', sessionOptions);

        this._melspecModel = await this._createSessionFromLocalFile(resolver(melspectrogram), sessionOptions);
        this._embeddingModel = await this._createSessionFromLocalFile(resolver(embedding), sessionOptions);
        this._vadModel = await this._createSessionFromLocalFile(resolver(vad), sessionOptions);

        this._keywordModels = {};
        let maxWindowSize = this.config.embeddingWindowSize;
        for (const keyword of this.config.keywords) {
            const file = this.config.modelFiles[keyword];
            if (!file) {
                throw new Error(`No model file configured for keyword "${keyword}"`);
            }
            const session = await this._createSessionFromLocalFile(resolver(file), sessionOptions);
            const windowSize = this._inferKeywordWindowSize(session) ?? this.config.embeddingWindowSize;
            maxWindowSize = Math.max(maxWindowSize, windowSize);
            const history: Float32Array[] = [];
            for (let i = 0; i < windowSize; i++) {
                history.push(new Float32Array(96).fill(0));
            }
            this._keywordModels[keyword] = {
                session,
                scores: new Array<number>(50).fill(0),
                windowSize,
                history,
                consecutiveHits: 0
            };
            this._debug('Loaded keyword model', { keyword, file, windowSize });
        }
        this._debug('Embedding window size resolved', maxWindowSize);
        this._resetState();
        this._loaded = true;
        this._emitter.emit('ready');
    }

    async processChunk(chunk: Float32Array, { emitEvents = true }: { emitEvents?: boolean } = {}): Promise<void> {
        if (!this._loaded) throw new Error('Call load() before processChunk()');
        await this._processChunk(chunk, { emitEvents });
    }

    private _resetState(): void {
        this._melBuffer = [];
        const vadShape = [2, 1, 64];
        if (!this._vadState.h || !this._vadState.c) {
            this._vadState.h = new ort.Tensor('float32', new Float32Array(128).fill(0), vadShape);
            this._vadState.c = new ort.Tensor('float32', new Float32Array(128).fill(0), vadShape);
        } else {
            (this._vadState.h.data as Float32Array).fill(0);
            (this._vadState.c.data as Float32Array).fill(0);
        }
        this._isSpeechActive = false;
        this._vadHangover = 0;
        this._isDetectionCoolingDown = false;
        for (const key of Object.keys(this._keywordModels)) {
            this._keywordModels[key].scores.fill(0);
            this._keywordModels[key].consecutiveHits = 0;
            const history = this._keywordModels[key].history;
            for (let i = 0; i < history.length; i++) {
                history[i].fill(0);
            }
        }
        this._debug('Internal buffers reset');
    }

    private async _processChunk(chunk: Float32Array, { emitEvents = true }: { emitEvents?: boolean } = {}): Promise<void> {
        if (this.config.debug) {
            let peak = 0;
            let sumSquares = 0;
            for (let i = 0; i < chunk.length; i++) {
                const sample = chunk[i];
                sumSquares += sample * sample;
                const abs = Math.abs(sample);
                if (abs > peak) peak = abs;
            }
            const rms = Math.sqrt(sumSquares / chunk.length);
            this._debug('Chunk received', { rms: Number(rms.toFixed(4)), peak: Number(peak.toFixed(4)) });
        }
        const vadTriggered = await this._runVad(chunk);
        if (vadTriggered) {
            if (!this._isSpeechActive && emitEvents) this._emitter.emit('speech-start');
            this._isSpeechActive = true;
            this._vadHangover = this.config.vadHangoverFrames;
        } else if (this._isSpeechActive) {
            this._vadHangover -= 1;
            if (this._vadHangover <= 0) {
                this._isSpeechActive = false;
                if (emitEvents) this._emitter.emit('speech-end');
            }
        }

        await this._runInference(chunk, this._isSpeechActive, emitEvents);
    }

    private async _runVad(chunk: Float32Array): Promise<boolean> {
        try {
            const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
            const sr = new ort.Tensor('int64', [BigInt(this.config.sampleRate)], []);
            const res = await this._vadModel.run({
                input: tensor,
                sr,
                h: this._vadState.h as ort.Tensor,
                c: this._vadState.c as ort.Tensor
            });
            this._vadState.h = res.hn as ort.Tensor;
            this._vadState.c = res.cn as ort.Tensor;
            const confidence = (res.output.data as Float32Array)[0] ?? 0;
            this._debug('VAD result', { confidence: Number(confidence.toFixed(3)) });
            const triggered = confidence > this.config.vadThreshold;
            this._emitter.emit('vad-result', { confidence, threshold: this.config.vadThreshold, triggered });
            return triggered;
        } catch (err) {
            this._emitter.emit('error', err);
            return false;
        }
    }

    private async _runInference(chunk: Float32Array, isSpeechActive: boolean, emitEvents: boolean): Promise<void> {
        const melspecTensor = new ort.Tensor('float32', chunk, [1, this.config.frameSize]);
        const melspecResults = await this._melspecModel.run({ [this._melspecModel.inputNames[0]]: melspecTensor });
        const newMelData = melspecResults[this._melspecModel.outputNames[0]].data as Float32Array;

        for (let j = 0; j < newMelData.length; j++) {
            newMelData[j] = newMelData[j] / 10.0 + 2.0;
        }
        for (let j = 0; j < 5; j++) {
            this._melBuffer.push(new Float32Array(newMelData.subarray(j * 32, (j + 1) * 32)));
        }

        while (this._melBuffer.length >= 76) {
            const windowFrames = this._melBuffer.slice(0, 76);
            const flattenedMel = new Float32Array(76 * 32);
            for (let j = 0; j < windowFrames.length; j++) {
                flattenedMel.set(windowFrames[j], j * 32);
            }

            const embeddingFeeds = {
                [this._embeddingModel.inputNames[0]]: new ort.Tensor('float32', flattenedMel, [1, 76, 32, 1])
            };
            const embeddingOut = await this._embeddingModel.run(embeddingFeeds);
            const newEmbedding = embeddingOut[this._embeddingModel.outputNames[0]].data as Float32Array;

            const embeddingVector = new Float32Array(newEmbedding);

            for (const name of Object.keys(this._keywordModels)) {
                const keywordModel = this._keywordModels[name];
                keywordModel.history.shift();
                keywordModel.history.push(embeddingVector);

                const flattenedEmbeddings = new Float32Array(keywordModel.windowSize * 96);
                for (let j = 0; j < keywordModel.history.length; j++) {
                    flattenedEmbeddings.set(keywordModel.history[j], j * 96);
                }
                const finalInput = new ort.Tensor('float32', flattenedEmbeddings, [1, keywordModel.windowSize, 96]);
                const results = await keywordModel.session.run({ [keywordModel.session.inputNames[0]]: finalInput });
                const score = (results[keywordModel.session.outputNames[0]].data as Float32Array)[0] ?? 0;
                keywordModel.scores.shift();
                keywordModel.scores.push(score);
                const speechGatePassed = !this.config.requireSpeechGate || isSpeechActive;
                if (score > this.config.detectionThreshold && speechGatePassed) {
                    keywordModel.consecutiveHits += 1;
                } else {
                    keywordModel.consecutiveHits = 0;
                }
                this._debug('Keyword score', {
                    keyword: name,
                    score: Number(score.toFixed(3)),
                    windowSize: keywordModel.windowSize,
                    hits: keywordModel.consecutiveHits
                });

                const keywordActive = this._activeKeywords.has(name);
                this._emitter.emit('frame-result', {
                    keyword: name,
                    score,
                    threshold: this.config.detectionThreshold,
                    hits: keywordModel.consecutiveHits,
                    minConsecutiveDetections: this.config.minConsecutiveDetections,
                    isSpeechActive,
                    speechGatePassed,
                    requireSpeechGate: this.config.requireSpeechGate,
                    keywordActive,
                    coolingDown: this._isDetectionCoolingDown
                });
                if (
                    emitEvents
                    && keywordActive
                    && speechGatePassed
                    && keywordModel.consecutiveHits >= this.config.minConsecutiveDetections
                    && !this._isDetectionCoolingDown
                ) {
                    this._isDetectionCoolingDown = true;
                    keywordModel.consecutiveHits = 0;
                    this._debug('Detection emitted', {
                        keyword: name,
                        score,
                        minConsecutiveDetections: this.config.minConsecutiveDetections
                    });
                    this._emitter.emit('detect', { keyword: name, score, at: performance.now() });
                    setTimeout(() => {
                        this._isDetectionCoolingDown = false;
                    }, this.config.cooldownMs);
                } else if (emitEvents && !keywordActive) {
                    this._debug('Detection suppressed (inactive keyword)', { keyword: name, score });
                }
            }
            this._melBuffer.splice(0, 8);
        }
    }

    private _resolveLocalModelPath(file: string): string {
        if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
            return file;
        }
        const basePath = `${this.config.baseModelPath || '.'}`.replace(/[\\/]+$/, '');
        const normalizedFile = `${file}`.replace(/^[\\/]+/, '');
        return `${basePath}/${normalizedFile}`;
    }

    private async _createSessionFromLocalFile(
        filePath: string,
        sessionOptions: ort.InferenceSession.SessionOptions
    ): Promise<ort.InferenceSession> {
        const fs = await this._getNodeFs();
        const modelBytes = await fs.readFile(filePath);
        return ort.InferenceSession.create(modelBytes, sessionOptions);
    }

    private async _getNodeFs(): Promise<typeof import('node:fs/promises')> {
        const isNodeRuntime = typeof process !== 'undefined' && !!process.versions?.node;
        if (!isNodeRuntime) {
            throw new Error('WakeWordEngine local model loading requires a Node.js runtime');
        }
        return import('node:fs/promises');
    }

    private _inferKeywordWindowSize(session: ort.InferenceSession): number | undefined {
        if (!session) return undefined;
        const inputName = session.inputNames?.[0];
        const metadata = session.inputMetadata as unknown;
        if (!metadata || !inputName) return undefined;
        let meta: { isTensor?: boolean; shape?: Array<number | string | null> } | undefined;
        if (Array.isArray(metadata)) {
            meta = (metadata.find((m: unknown) => {
                return !!m && typeof m === 'object' && 'name' in (m as Record<string, unknown>) && (m as { name?: string }).name === inputName;
            }) as { isTensor?: boolean; shape?: Array<number | string | null> } | undefined) ??
                (metadata[0] as { isTensor?: boolean; shape?: Array<number | string | null> } | undefined);
        } else {
            meta = (metadata as Record<string, { isTensor?: boolean; shape?: Array<number | string | null> }>)?.[inputName];
        }
        if (!meta || !meta.isTensor || !Array.isArray(meta.shape)) return undefined;
        const dim = meta.shape[1];
        return typeof dim === 'number' && Number.isFinite(dim) ? dim : undefined;
    }

    private _debug(...args: unknown[]): void {
        if (this.config.debug) {
            console.debug('[WakeWordEngine]', ...args);
        }
    }
}
