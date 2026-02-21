import { TeamSpeakClient } from '../index';
import { clearLlmContext, inferFromAudioStream, pcm16leToWav } from './llm';
import { createAzureTtsStreamSession } from './tts';

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const FRAME_INTERVAL_MS = 20;
const COMMAND_START = '%b';
const COMMAND_END = '%e';
const COMMAND_CLEAR = '%clear';
const COMMAND_HELP = '%help';
const MAX_MESSAGE_CHARS = 450;

type RunState = 'standby' | 'recording' | 'waiting_model';

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
		// fenced code blocks
		.replace(/```[\s\S]*?```/g, ' ')
		// inline code
		.replace(/`([^`]+)`/g, '$1')
		// markdown links [text](url) -> text
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
		// images ![alt](url) -> alt
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
		// heading markers, blockquote, list markers
		.replace(/^\s{0,3}(#{1,6}|\*|-|\+|>|- \[.\])\s+/gm, '')
		// emphasis / strong / strike
		.replace(/(\*\*|__|\*|_|~~)/g, '')
		// horizontal rules
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

async function main() {
	const address = process.env.TS_ADDRESS ?? 'localhost';
	const password = process.env.TS_PASSWORD;
	const channel = process.env.TS_CHANNEL;
	const nickname = process.env.TS_NICKNAME ?? 'ts-audio-llm-demo';

	const client = new TeamSpeakClient();
	const audioChunks: Buffer[] = [];

	let currentClientId: number = 0;

	let state: RunState = 'standby';
	const setState = (next: RunState): void => {
		state = next;
		logWithTimestamp('log', '[state]', state);
	};

	let eventQueue: Promise<void> = Promise.resolve();
	const enqueueEvent = (task: () => Promise<void>): void => {
		eventQueue = eventQueue.then(task, task);
	};

	let shuttingDown = false;
	let currentInference: Promise<void> | null = null;

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
		const ttsSession = createAzureTtsStreamSession({
			requestTimeoutMs: 30000,
		});
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

	const playStartupTts = async (): Promise<void> => {
		await playTtsText('你好，我来啦。');
	};

	const runModelReply = async (): Promise<void> => {
		const pcm = Buffer.concat(audioChunks);
		audioChunks.length = 0;

		if (pcm.length === 0) {
			await sendChannelText('[ai-bot]没有捕获到有效音频，请重试。');
			setState('standby');
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
	};

	const handleCommand = async (message: string, clientId: number): Promise<void> => {
		switch (message) {
			case COMMAND_HELP:
				await sendChannelText(`[ai-bot]可用指令：
${COMMAND_START} - 开始录音
${COMMAND_END} - 结束录音并让模型回复
${COMMAND_CLEAR} - 清除模型上下文
${COMMAND_HELP} - 显示帮助`);
				break;
			case COMMAND_CLEAR:
				clearLlmContext();
				await sendChannelText('[ai-bot]上下文已清除。');
				break;
			case COMMAND_START:
				if (state === 'standby') {
					if (clientId === 0) {
						throw Error('[ai-bot]错误！无法获得说话人id！');
					}
					audioChunks.length = 0;
					setState('recording');
					currentClientId = clientId;
					await sendChannelText(`[ai-bot]我正在听${clientId}说话...`);
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

				setState('waiting_model');
				await sendChannelText('[ai-bot]我听到了，正在生成回复...');
				// Run long model call in background so queue stays responsive.
				currentInference = runModelReply()
					.catch(async (err) => {
						logWithTimestamp('error', '[inference error]', err);
						try {
							await sendChannelText('[ai-bot]生成回复失败，请稍后再试。');
						} catch (sendErr) {
							logWithTimestamp('error', '[send error after inference failure]', sendErr);
						}
						setState('standby');
					})
					.finally(() => {
						currentInference = null;
					});
				break;
			default:
				break;
		}
	};

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
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
			setState('standby');
			process.exit(0);
		}
	};

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
		if (state === 'recording'
			&& payload.clientId === currentClientId
			&& Buffer.isBuffer(payload.pcm)) {
			audioChunks.push(Buffer.from(payload.pcm));
		}
	})

	await client.connect({
		address,
		password,
		channel,
		nickname,
		logLevel: 'off',
	});

	try {
		await playStartupTts();
	} catch (err) {
		logWithTimestamp('error', '[tts startup failed]', err);
	}

	setState('standby');
	logWithTimestamp('log', `[ready] send "${COMMAND_START}" to start recording, "${COMMAND_END}" to stop and infer`);

	process.on('SIGINT', () => {
		void shutdown('SIGINT');
	});

	process.on('SIGTERM', () => {
		void shutdown('SIGTERM');
	});

	await new Promise<void>(() => undefined);
}

main().catch((err) => {
	logWithTimestamp('error', err);
	process.exit(1);
});
