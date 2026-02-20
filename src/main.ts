import { TeamSpeakClient } from '../index';
import { inferFromAudioStream, pcm16leToWav } from './llm';

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const COMMAND_START = '%b';
const COMMAND_END = '%e';
const MAX_MESSAGE_CHARS = 450;

type RunState = 'standby' | 'recording' | 'waiting_model';

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
		console.log('[state]', state);
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

	const runModelReply = async (): Promise<void> => {
		const pcm = Buffer.concat(audioChunks);
		audioChunks.length = 0;

		if (pcm.length === 0) {
			await sendChannelText('[ai-bot]没有捕获到有效音频，请重试。');
			setState('standby');
			return;
		}

		const wav = pcm16leToWav(pcm, SAMPLE_RATE, CHANNELS);
		console.log('[llm] sending audio to model...', { pcmBytes: pcm.length, wavBytes: wav.length });

		let streamText = '';
		await inferFromAudioStream(wav, {
			format: 'wav',
			prompt: '你是一个无问不答的语音助手。请使用自然、简洁的语言和音频里面的人对话，解答他的所有问题或者满足他的其他要求。',
			reasoningEnabled: true,
			onTextDelta: (delta) => {
				streamText += delta;
			},
		});

		const reply = streamText.trim() || '我听到了，但这次没有生成可用文本。';
		const parts = splitMessage(reply, MAX_MESSAGE_CHARS);

		if (parts.length === 0) {
			await sendChannelText('[ai-bot]模型没有返回可发送文本。');
		} else {
			for (const part of parts) {
				await sendChannelText(part);
			}
		}

		setState('standby');
	};

	const handleCommand = async (message: string, clientId: number): Promise<void> => {
		switch (message) {
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
						console.error('[inference error]', err);
						try {
							await sendChannelText('[ai-bot]生成回复失败，请稍后再试。');
						} catch (sendErr) {
							console.error('[send error after inference failure]', sendErr);
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
		console.log(`[shutdown] ${signal}`);

		try {
			if (currentInference) {
				console.log('[shutdown] inference in progress, disconnecting immediately');
			}
			if (client.isConnected()) {
				await client.disconnect({ message: 'ai bot shutting down' });
			}
		} catch (err) {
			console.error('[shutdown error]', err);
		} finally {
			setState('standby');
			process.exit(0);
		}
	};

	client.on('connected', (payload) => {
		console.log('[connected]', payload);
	});

	client.on('disconnected', (payload) => {
		console.log('[disconnected]', payload);
	});

	client.on('error', (payload) => {
		console.error('[error]', payload);
	});

	client.on('textMessage', (payload) => {
		enqueueEvent(async () => {
			try {
				const text = payload.message.trim();
				if (!text.startsWith('%')) return;
				console.log('[message]', payload);
				await handleCommand(text, payload.invoker.id);
			} catch (err) {
				console.error('[textMessage handler error]', err);
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

	setState('standby');
	console.log(`[ready] send "${COMMAND_START}" to start recording, "${COMMAND_END}" to stop and infer`);

	process.on('SIGINT', () => {
		void shutdown('SIGINT');
	});

	process.on('SIGTERM', () => {
		void shutdown('SIGTERM');
	});

	await new Promise<void>(() => undefined);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
