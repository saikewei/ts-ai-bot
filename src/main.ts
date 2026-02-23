import { TeamSpeakClient } from '../index';
import { clearLlmContext, inferFromAudioStream, pcm16leToWav } from './llm';
import { createAzureTtsStreamSession } from './tts';
import { WakeWordEngine } from './wake_word_engine';
import * as fs from 'node:fs/promises';

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const FRAME_INTERVAL_MS = 20;
const COMMAND_START = '%b';
const COMMAND_END = '%e';
const COMMAND_CLEAR = '%clear';
const COMMAND_HELP = '%help';
const MAX_MESSAGE_CHARS = 450;
const WAKE_ACK_TEXT = '我在';

const MODELS_DIR = process.env.MODELS_DIR ?? '/app/models';
const CORE_MELSPEC_MODEL_PATH = process.env.CORE_MELSPEC_MODEL_PATH ?? `${MODELS_DIR}/melspectrogram.onnx`;
const CORE_EMBED_MODEL_PATH = process.env.CORE_EMBED_MODEL_PATH ?? `${MODELS_DIR}/embedding_model.onnx`;
const CORE_VAD_MODEL_PATH = process.env.CORE_VAD_MODEL_PATH ?? `${MODELS_DIR}/silero_vad.onnx`;
const WAKEWORD_MODEL_PATH = process.env.WAKEWORD_MODEL_PATH ?? `${MODELS_DIR}/wakeword.onnx`;
const WAKEWORD_NAME = process.env.WAKEWORD_NAME ?? 'wakeword';
const WAKE_ACK_WAV_PATH = process.env.WAKE_ACK_WAV_PATH ?? `${MODELS_DIR}/wake_ack.wav`;

const SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS ?? 1500);
const WAKEWORD_THRESHOLD = Number(process.env.WAKEWORD_THRESHOLD ?? 0.5);
const WAKEWORD_COOLDOWN_MS = 2000;
const WAKEWORD_VAD_THRESHOLD = Number(process.env.WAKEWORD_VAD_THRESHOLD ?? 0.38);
const WAKEWORD_VAD_HANGOVER_FRAMES = Number(process.env.WAKEWORD_VAD_HANGOVER_FRAMES ?? 8);
const WAKEWORD_FRAME_LOG = process.env.WAKEWORD_FRAME_LOG === '1';
const DETECTOR_SAMPLE_RATE = 16_000;
const DETECTOR_FRAME_SIZE = 1280;

const DETECTOR_IDLE_TTL_MS = 5 * 60_000;
const DETECTOR_CLEANUP_INTERVAL_MS = 60_000;

type RunState = 'standby' | 'wakeup_ack' | 'recording' | 'waiting_model';

type RecordingSource = 'wakeword' | 'command';

type EndReason = 'manual' | 'silence';

interface SpeakerDetectorContext {
	engine: WakeWordEngine;
	loaded: boolean;
	queue: Promise<void>;
	resampleCarry: Int16Array;
	detectorCarry: Float32Array;
	lastSeenAtMs: number;
	offReady?: () => void;
	offDetect?: () => void;
	offFrameResult?: () => void;
	offSpeechStart?: () => void;
	offSpeechEnd?: () => void;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitMessage(text: string, maxChars: number): string[] {
	if (!text.trim()) return [];
	const parts: string[] = [];
	let rest = text.trim();
	while (rest.length > maxChars) {
		let cut = rest.lastIndexOf(' ', maxChars);
		if (cut <= 0) cut = maxChars;
		parts.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) parts.push(rest);
	return parts;
}

function stripMarkdownForTts(input: string): string {
	return input
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
		.replace(/^\s{0,3}(#{1,6}|\*|-|\+|>|- \[.\])\s+/gm, '')
		.replace(/(\*\*|__|\*|_|~~)/g, '')
		.replace(/^\s{0,3}([-*_]\s?){3,}$/gm, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function formatDurationMs(startNs: bigint, endNs: bigint): string {
	return `${(Number(endNs - startNs) / 1_000_000).toFixed(2)}ms`;
}

const LOG_TIMEZONE = process.env.LOG_TIMEZONE
	?? Intl.DateTimeFormat().resolvedOptions().timeZone
	?? 'UTC';

function nowWithTimezone(): string {
	const parts = new Intl.DateTimeFormat('sv-SE', {
		timeZone: LOG_TIMEZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		fractionalSecondDigits: 3,
		hour12: false,
	}).formatToParts(new Date());
	const pick = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}.${pick('fractionalSecond')}`;
}

function logWithTimestamp(level: 'log' | 'error', ...args: unknown[]): void {
	console[level](`[${nowWithTimezone()}]`, ...args);
}

function extractModelText(content: unknown): string {
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
		.join('')
		.trim();
}

function isFinitePositive(n: number): boolean {
	return Number.isFinite(n) && n > 0;
}

function pcm16BufferToInt16Array(buf: Buffer): Int16Array {
	if (buf.length % 2 !== 0) {
		return new Int16Array(buf.subarray(0, buf.length - 1).buffer, buf.subarray(0, buf.length - 1).byteOffset, (buf.length - 1) / 2);
	}
	return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

function downsample48kTo16k(input: Int16Array, carry: Int16Array): { out: Float32Array; carry: Int16Array } {
	const merged = new Int16Array(carry.length + input.length);
	merged.set(carry, 0);
	merged.set(input, carry.length);

	const groups = Math.floor(merged.length / 3);
	const out = new Float32Array(groups);
	let src = 0;
	for (let i = 0; i < groups; i += 1) {
		const s0 = merged[src];
		const s1 = merged[src + 1];
		const s2 = merged[src + 2];
		out[i] = ((s0 + s1 + s2) / 3) / 32768;
		src += 3;
	}

	const remain = merged.length - groups * 3;
	const nextCarry = remain > 0 ? merged.slice(merged.length - remain) : new Int16Array(0);
	return { out, carry: nextCarry };
}

function appendFloat32(a: Float32Array, b: Float32Array): Float32Array {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Float32Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function wavToTsFrames(wav: Buffer): Buffer[] {
	const riff = wav.toString('ascii', 0, 4);
	const wave = wav.toString('ascii', 8, 12);
	if (riff !== 'RIFF' || wave !== 'WAVE') {
		throw new Error('Invalid wake ack WAV: not RIFF/WAVE');
	}

	let offset = 12;
	let fmtAudioFormat = 0;
	let fmtChannels = 0;
	let fmtSampleRate = 0;
	let fmtBitsPerSample = 0;
	let dataOffset = 0;
	let dataSize = 0;

	while (offset + 8 <= wav.length) {
		const id = wav.toString('ascii', offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const body = offset + 8;
		const next = body + size + (size % 2);
		if (next > wav.length) break;

		if (id === 'fmt ' && size >= 16) {
			fmtAudioFormat = wav.readUInt16LE(body);
			fmtChannels = wav.readUInt16LE(body + 2);
			fmtSampleRate = wav.readUInt32LE(body + 4);
			fmtBitsPerSample = wav.readUInt16LE(body + 14);
		} else if (id === 'data') {
			dataOffset = body;
			dataSize = size;
			break;
		}
		offset = next;
	}

	if (!dataOffset || dataSize <= 0) throw new Error('Invalid wake ack WAV: missing data chunk');
	if (fmtAudioFormat !== 1 || fmtChannels !== 1 || fmtSampleRate !== 48000 || fmtBitsPerSample !== 16) {
		throw new Error(`Invalid wake ack WAV format: format=${fmtAudioFormat}, channels=${fmtChannels}, sampleRate=${fmtSampleRate}, bits=${fmtBitsPerSample}`);
	}

	const pcm = wav.subarray(dataOffset, dataOffset + dataSize);
	const frameBytes = 960 * 2;
	const frames: Buffer[] = [];
	for (let i = 0; i < pcm.length; i += frameBytes) {
		const chunk = pcm.subarray(i, Math.min(i + frameBytes, pcm.length));
		if (chunk.length === frameBytes) {
			frames.push(Buffer.from(chunk));
		} else {
			const padded = Buffer.alloc(frameBytes);
			chunk.copy(padded);
			frames.push(padded);
		}
	}
	return frames;
}

async function main() {
	if (!isFinitePositive(SILENCE_TIMEOUT_MS)) {
		throw new Error(`Invalid SILENCE_TIMEOUT_MS: ${SILENCE_TIMEOUT_MS}`);
	}
	if (!isFinitePositive(WAKEWORD_THRESHOLD) || WAKEWORD_THRESHOLD >= 1) {
		throw new Error(`Invalid WAKEWORD_THRESHOLD: ${WAKEWORD_THRESHOLD}`);
	}
	if (!isFinitePositive(WAKEWORD_VAD_THRESHOLD) || WAKEWORD_VAD_THRESHOLD >= 1) {
		throw new Error(`Invalid WAKEWORD_VAD_THRESHOLD: ${WAKEWORD_VAD_THRESHOLD}`);
	}
	if (!Number.isFinite(WAKEWORD_VAD_HANGOVER_FRAMES) || WAKEWORD_VAD_HANGOVER_FRAMES < 0) {
		throw new Error(`Invalid WAKEWORD_VAD_HANGOVER_FRAMES: ${WAKEWORD_VAD_HANGOVER_FRAMES}`);
	}
	const address = process.env.TS_ADDRESS ?? 'localhost';
	const password = process.env.TS_PASSWORD;
	const channel = process.env.TS_CHANNEL;
	const nickname = process.env.TS_NICKNAME ?? 'ts-audio-llm-demo';

	logWithTimestamp('log', '[wakeword config]', {
		modelsDir: MODELS_DIR,
		core: {
			melspectrogram: CORE_MELSPEC_MODEL_PATH,
			embedding: CORE_EMBED_MODEL_PATH,
			vad: CORE_VAD_MODEL_PATH,
		},
		wakewordModel: WAKEWORD_MODEL_PATH,
		wakewordName: WAKEWORD_NAME,
		wakeAckWavPath: WAKE_ACK_WAV_PATH,
		silenceTimeoutMs: SILENCE_TIMEOUT_MS,
		threshold: WAKEWORD_THRESHOLD,
		cooldownMs: WAKEWORD_COOLDOWN_MS,
		vadThreshold: WAKEWORD_VAD_THRESHOLD,
		vadHangoverFrames: WAKEWORD_VAD_HANGOVER_FRAMES,
		frameLog: WAKEWORD_FRAME_LOG,
	});

	const client = new TeamSpeakClient();
	const detectorBySpeaker = new Map<number, SpeakerDetectorContext>();

	let state: RunState = 'standby';
	let activeSpeakerId: number | null = null;
	let recordingSource: RecordingSource | null = null;
	let recordingPcmChunks: Buffer[] = [];
	let silenceTimer: NodeJS.Timeout | null = null;
	let shuttingDown = false;
	let currentInference: Promise<void> | null = null;
	let wakeAckFrames: Buffer[] = [];

	const setState = (next: RunState): void => {
		state = next;
		logWithTimestamp('log', '[state]', state);
	};

	const clearSilenceTimer = (): void => {
		if (silenceTimer) {
			clearTimeout(silenceTimer);
			silenceTimer = null;
		}
	};

	const sendChannelText = async (message: string): Promise<void> => {
		await client.sendTextMessage({ target: 'channel', message });
	};

	const pushFrameWithRetry = async (frame: Buffer): Promise<void> => {
		const maxAttempts = 5;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				client.pushFrame(frame);
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const isQueueFull = message.includes('Audio queue is full');
				if (!isQueueFull || attempt === maxAttempts) {
					throw err;
				}
				await sleep(FRAME_INTERVAL_MS);
			}
		}
	};

	const playTtsText = async (text: string): Promise<void> => {
		const ttsSession = createAzureTtsStreamSession({ requestTimeoutMs: 30000 });
		const cleaned = stripMarkdownForTts(text);
		if (!cleaned) return;
		const ttsGenStart = process.hrtime.bigint();
		ttsSession.pushText(cleaned);
		const playbackPromise = (async () => {
			for await (const frame of ttsSession.readFrames()) {
				if (frame.length === 0) continue;
				await pushFrameWithRetry(frame);
				await sleep(FRAME_INTERVAL_MS);
			}
		})();
		try {
			await ttsSession.endInput();
		} finally {
			const ttsGenEnd = process.hrtime.bigint();
			logWithTimestamp('log', '[timing] tts_generation', formatDurationMs(ttsGenStart, ttsGenEnd));
		}
		await playbackPromise;
	};

	const playCachedFrames = async (frames: Buffer[]): Promise<void> => {
		for (const frame of frames) {
			if (frame.length === 0) continue;
			await pushFrameWithRetry(frame);
			await sleep(FRAME_INTERVAL_MS);
		}
	};

	const playStartupTts = async (): Promise<void> => {
		await playTtsText('你好，我来啦。');
	};

	const resetConversationLock = (): void => {
		clearSilenceTimer();
		activeSpeakerId = null;
		recordingSource = null;
		recordingPcmChunks = [];
	};

	const runModelReply = async (): Promise<void> => {
		const pcm = Buffer.concat(recordingPcmChunks);
		recordingPcmChunks = [];

		if (pcm.length === 0) {
			await sendChannelText('[ai-bot]没有捕获到有效音频，请重试。');
			setState('standby');
			resetConversationLock();
			return;
		}

		const wav = pcm16leToWav(pcm, SAMPLE_RATE, CHANNELS);
		logWithTimestamp('log', '[llm] sending audio to model...', { pcmBytes: pcm.length, wavBytes: wav.length });

		let streamText = '';
		const llmStart = process.hrtime.bigint();
		const inference = await inferFromAudioStream(wav, {
			format: 'wav',
			prompt: '你是一个无问不答的语音助手。请使用自然、简洁的语言和音频里面的人对话，解答他的所有问题或者满足他的其他要求。',
			reasoningEnabled: true,
			onTextDelta: (delta) => {
				streamText += delta;
			},
		});
		const llmEnd = process.hrtime.bigint();
		logWithTimestamp('log', '[timing] model_inference', formatDurationMs(llmStart, llmEnd));

		if (!streamText.trim()) {
			streamText = extractModelText(inference.message.content);
		}

		const reply = streamText.trim() || '我听到了，但这次没有生成可用文本。';
		const parts = splitMessage(reply, MAX_MESSAGE_CHARS);

		if (parts.length === 0) {
			await sendChannelText('[ai-bot]模型没有返回可发送文本。');
		} else {
			const ttsText = parts.join('\n');
			await playTtsText(ttsText);
		}

		setState('standby');
		resetConversationLock();
	};

	const finalizeRecording = async (reason: EndReason): Promise<void> => {
		if (state !== 'recording' || activeSpeakerId == null) return;
		const speakerId = activeSpeakerId;
		clearSilenceTimer();
		setState('waiting_model');
		await sendChannelText(`[ai-bot]已结束收听（${reason === 'manual' ? '手动' : '静音'}），正在生成回复...`);
		logWithTimestamp('log', '[recording finalize]', {
			reason,
			speakerId,
			source: recordingSource,
			bytes: recordingPcmChunks.reduce((acc, b) => acc + b.length, 0),
		});

		currentInference = runModelReply()
			.catch(async (err) => {
				logWithTimestamp('error', '[inference error]', err);
				try {
					await sendChannelText('[ai-bot]生成回复失败，请稍后再试。');
				} catch (sendErr) {
					logWithTimestamp('error', '[send error after inference failure]', sendErr);
				}
				setState('standby');
				resetConversationLock();
			})
			.finally(() => {
				currentInference = null;
			});
	};

	const armSilenceTimer = (): void => {
		if (state !== 'recording' || activeSpeakerId == null) return;
		clearSilenceTimer();
		silenceTimer = setTimeout(() => {
			void finalizeRecording('silence');
		}, SILENCE_TIMEOUT_MS);
	};

	const tryStartSession = async (speakerId: number, source: RecordingSource): Promise<boolean> => {
		if (speakerId === 0) {
			logWithTimestamp('error', '[session] invalid speakerId=0');
			return false;
		}
		if (state !== 'standby') {
			logWithTimestamp('log', '[session ignored]', { speakerId, source, state, activeSpeakerId });
			return false;
		}
		activeSpeakerId = speakerId;
		recordingSource = source;
		recordingPcmChunks = [];
		clearSilenceTimer();

		if (source === 'wakeword') {
			setState('wakeup_ack');
			logWithTimestamp('log', '[wakeup ack]', { speakerId, text: WAKE_ACK_TEXT, frames: wakeAckFrames.length });
			try {
				if (wakeAckFrames.length > 0) {
					await playCachedFrames(wakeAckFrames);
				}
			} catch (err) {
				logWithTimestamp('error', '[wakeup ack playback failed]', err);
			}
			if (activeSpeakerId !== speakerId) {
				return false;
			}
		}

		setState('recording');
		logWithTimestamp('log', '[session started]', { speakerId, source });
		// await sendChannelText(`[ai-bot]我正在听 ${speakerId} 说话...`);
		return true;
	};

	const ensureSpeakerDetector = (speakerId: number): SpeakerDetectorContext => {
		const existing = detectorBySpeaker.get(speakerId);
		if (existing) {
			existing.lastSeenAtMs = Date.now();
			return existing;
		}

		const engine = new WakeWordEngine({
			keywords: [WAKEWORD_NAME],
			modelFiles: {
				[WAKEWORD_NAME]: WAKEWORD_MODEL_PATH,
			},
			coreModelFiles: {
				melspectrogram: CORE_MELSPEC_MODEL_PATH,
				embedding: CORE_EMBED_MODEL_PATH,
				vad: CORE_VAD_MODEL_PATH,
			},
			baseModelPath: '/',
			sampleRate: DETECTOR_SAMPLE_RATE,
			frameSize: DETECTOR_FRAME_SIZE,
			vadHangoverFrames: Math.floor(WAKEWORD_VAD_HANGOVER_FRAMES),
			detectionThreshold: WAKEWORD_THRESHOLD,
			minConsecutiveDetections: 1,
			vadThreshold: WAKEWORD_VAD_THRESHOLD,
			requireSpeechGate: true,
			cooldownMs: WAKEWORD_COOLDOWN_MS,
			executionProviders: ['wasm'],
			debug: false,
		});

		const ctx: SpeakerDetectorContext = {
			engine,
			loaded: false,
			queue: Promise.resolve(),
			resampleCarry: new Int16Array(0),
			detectorCarry: new Float32Array(0),
			lastSeenAtMs: Date.now(),
		};

		ctx.offReady = engine.on('ready', () => {
			logWithTimestamp('log', '[wakeword ready]', { speakerId });
		});

		ctx.offDetect = engine.on('detect', () => {
			void tryStartSession(speakerId, 'wakeword').catch((err) => {
				logWithTimestamp('error', '[wakeword detect start error]', { speakerId, err });
			});
		});

		ctx.offFrameResult = engine.on('frame-result', (payload) => {
			if (!WAKEWORD_FRAME_LOG) return;
			const p = payload as {
				keyword?: string;
				score?: number;
				threshold?: number;
				hits?: number;
				minConsecutiveDetections?: number;
				isSpeechActive?: boolean;
				speechGatePassed?: boolean;
				keywordActive?: boolean;
				coolingDown?: boolean;
			} | undefined;
			if (!p || typeof p.score !== 'number' || !Number.isFinite(p.score)) return;
			const displayScore = Number(p.score.toFixed(3));
			if (displayScore === 0) return;
			logWithTimestamp('log', '[wakeword frame]', {
				speakerId,
				keyword: p.keyword,
				score: displayScore,
				threshold: p.threshold,
				hits: p.hits,
				minHits: p.minConsecutiveDetections,
				speech: p.isSpeechActive,
				speechGatePassed: p.speechGatePassed,
				active: p.keywordActive,
				cooldown: p.coolingDown,
			});
		});

		ctx.offSpeechStart = engine.on('speech-start', () => {
			if (state === 'recording' && activeSpeakerId === speakerId) {
				clearSilenceTimer();
			}
		});

		ctx.offSpeechEnd = engine.on('speech-end', () => {
			if (state === 'recording' && activeSpeakerId === speakerId) {
				armSilenceTimer();
			}
		});

		detectorBySpeaker.set(speakerId, ctx);
		return ctx;
	};

	const releaseSpeakerDetector = (speakerId: number): void => {
		const ctx = detectorBySpeaker.get(speakerId);
		if (!ctx) return;
		ctx.offReady?.();
		ctx.offDetect?.();
		ctx.offFrameResult?.();
		ctx.offSpeechStart?.();
		ctx.offSpeechEnd?.();
		detectorBySpeaker.delete(speakerId);
	};

	const processSpeakerWakeword = (speakerId: number, pcm: Buffer): void => {
		const ctx = ensureSpeakerDetector(speakerId);
		ctx.lastSeenAtMs = Date.now();
		ctx.queue = ctx.queue.then(async () => {
			if (!ctx.loaded) {
				await ctx.engine.load();
				ctx.loaded = true;
			}
			const pcm16 = pcm16BufferToInt16Array(pcm);
			const down = downsample48kTo16k(pcm16, ctx.resampleCarry);
			ctx.resampleCarry = down.carry;
			ctx.detectorCarry = appendFloat32(ctx.detectorCarry, down.out);

			while (ctx.detectorCarry.length >= DETECTOR_FRAME_SIZE) {
				const chunk = ctx.detectorCarry.subarray(0, DETECTOR_FRAME_SIZE);
				await ctx.engine.processChunk(chunk, { emitEvents: true });
				ctx.detectorCarry = ctx.detectorCarry.slice(DETECTOR_FRAME_SIZE);
			}
		}).catch((err) => {
			logWithTimestamp('error', '[wakeword processing error]', { speakerId, err });
		});
	};

	const handleCommand = async (message: string, clientId: number): Promise<void> => {
		switch (message) {
			case COMMAND_HELP:
				await sendChannelText(`[ai-bot]可用指令：
${COMMAND_START} - 开始录音（也支持唤醒词自动开始）
${COMMAND_END} - 结束录音并让模型回复（也支持1.5秒静音自动结束）
${COMMAND_CLEAR} - 清除模型上下文
${COMMAND_HELP} - 显示帮助`);
				break;
			case COMMAND_CLEAR:
				clearLlmContext();
				await sendChannelText('[ai-bot]上下文已清除。');
				break;
				case COMMAND_START:
					if (state === 'standby') {
						const started = await tryStartSession(clientId, 'command');
						if (!started) {
							await sendChannelText('[ai-bot]暂时无法开始录音。');
						}
					} else if (state === 'wakeup_ack') {
						await sendChannelText('[ai-bot]已唤醒，正在准备收听，请稍候。');
					} else if (state === 'recording') {
						await sendChannelText('[ai-bot]录音已经在进行！');
					} else {
					await sendChannelText('[ai-bot]正在生成回复，请稍候。');
				}
				break;
			case COMMAND_END:
				if (state !== 'recording') {
					await sendChannelText('[ai-bot]目前不在录制状态哦！');
					break;
				}
				await finalizeRecording('manual');
				break;
			default:
				break;
		}
	};

	let eventQueue: Promise<void> = Promise.resolve();
	const enqueueEvent = (task: () => Promise<void>): void => {
		eventQueue = eventQueue.then(task, task);
	};

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		clearSilenceTimer();
		logWithTimestamp('log', `[shutdown] ${signal}`);

		try {
			if (currentInference) {
				logWithTimestamp('log', '[shutdown] inference in progress, disconnecting immediately');
			}
			if (client.isConnected()) {
				await client.disconnect({ message: 'ai bot shutting down' });
			}
		} catch (err) {
			logWithTimestamp('error', '[shutdown error]', err);
		} finally {
			for (const speakerId of detectorBySpeaker.keys()) {
				releaseSpeakerDetector(speakerId);
			}
			setState('standby');
			process.exit(0);
		}
	};

	const detectorGcTimer = setInterval(() => {
		if (state !== 'standby') return;
		const now = Date.now();
		for (const [speakerId, ctx] of detectorBySpeaker.entries()) {
			if (now - ctx.lastSeenAtMs > DETECTOR_IDLE_TTL_MS) {
				releaseSpeakerDetector(speakerId);
				logWithTimestamp('log', '[wakeword gc release]', { speakerId });
			}
		}
	}, DETECTOR_CLEANUP_INTERVAL_MS);

	client.on('connected', (payload) => {
		logWithTimestamp('log', '[connected]', payload);
	});

	client.on('disconnected', (payload) => {
		logWithTimestamp('log', '[disconnected]', payload);
	});

	client.on('error', (payload) => {
		logWithTimestamp('error', '[error]', payload);
	});

	client.on('textMessage', (payload) => {
		enqueueEvent(async () => {
			try {
				const text = payload.message.trim();
				if (!text.startsWith('%')) return;
				logWithTimestamp('log', '[message]', payload);
				await handleCommand(text, payload.invoker.id);
			} catch (err) {
				logWithTimestamp('error', '[textMessage handler error]', err);
			}
		});
	});

	client.on('audioSpeaker', (payload) => {
		if (!Buffer.isBuffer(payload.pcm)) return;
		const speakerId = payload.clientId;
		const pcm = Buffer.from(payload.pcm);

		processSpeakerWakeword(speakerId, pcm);

		if (state === 'recording' && activeSpeakerId === speakerId) {
			armSilenceTimer();
			recordingPcmChunks.push(pcm);
		}
	});

	await client.connect({
		address,
		password,
		channel,
		nickname,
		logLevel: 'off',
	});

	try {
		const wav = await fs.readFile(WAKE_ACK_WAV_PATH);
		wakeAckFrames = wavToTsFrames(wav);
		logWithTimestamp('log', '[wakeup ack loaded]', { path: WAKE_ACK_WAV_PATH, frames: wakeAckFrames.length });
	} catch (err) {
		logWithTimestamp('error', '[wakeup ack load failed]', err);
		wakeAckFrames = [];
	}

	try {
		await playStartupTts();
	} catch (err) {
		logWithTimestamp('error', '[tts startup failed]', err);
	}

	setState('standby');
	logWithTimestamp('log', `[ready] 自动唤醒已启用；也可发送 "${COMMAND_START}" 手动开始，"${COMMAND_END}" 手动结束`);

	process.on('SIGINT', () => {
		clearInterval(detectorGcTimer);
		void shutdown('SIGINT');
	});

	process.on('SIGTERM', () => {
		clearInterval(detectorGcTimer);
		void shutdown('SIGTERM');
	});

	await new Promise<void>(() => undefined);
}

main().catch((err) => {
	logWithTimestamp('error', err);
	process.exit(1);
});
