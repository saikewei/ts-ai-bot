export interface LlmContextTurn {
	role: 'user' | 'assistant' | 'system';
	text: string;
	ts: number;
}

export interface LlmContextConfig {
	maxRecentTurns: number;
	maxSummaryChars: number;
	maxTurnChars: number;
	enableAutoSummarize: boolean;
	summaryPrompt?: string;
}

const DEFAULT_CONTEXT_CONFIG: LlmContextConfig = {
	maxRecentTurns: 6,
	maxSummaryChars: 1200,
	maxTurnChars: 400,
	enableAutoSummarize: true,
};

let contextConfig: LlmContextConfig = { ...DEFAULT_CONTEXT_CONFIG };
let contextSummary = '';
let recentTurns: LlmContextTurn[] = [];
let turnCount = 0;
let contextOps: Promise<void> = Promise.resolve();

function runInContextQueue<T>(task: () => Promise<T>): Promise<T> {
	const run = contextOps.then(task, task);
	contextOps = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function trimToMaxChars(text: string, maxChars: number): string {
	const clean = text.trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, Math.max(1, maxChars - 1))}…`;
}

function safeText(input: unknown): string {
	if (typeof input === 'string') return input;
	if (Array.isArray(input)) return input.map(safeText).join('\n');
	if (input == null) return '';
	return String(input);
}

function extractFinalText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return safeText(content);
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'text' in part) {
				return String((part as { text?: unknown }).text ?? '');
			}
			return '';
		})
		.filter(Boolean)
		.join('\n')
		.trim();
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

function normalizeTurn(turn: LlmContextTurn): LlmContextTurn {
	return {
		role: turn.role,
		text: trimToMaxChars(safeText(turn.text), contextConfig.maxTurnChars),
		ts: Number.isFinite(turn.ts) ? turn.ts : Date.now(),
	};
}

function formatTurnsForSummary(turns: LlmContextTurn[]): string {
	return turns.map((t) => `[${t.role}] ${t.text}`).join('\n');
}

function buildSummaryFallback(previousSummary: string, overflow: LlmContextTurn[]): string {
	const merged = [previousSummary, formatTurnsForSummary(overflow)].filter(Boolean).join('\n');
	return trimToMaxChars(merged, contextConfig.maxSummaryChars);
}

async function fetchOpenRouterJson(apiKey: string, body: unknown): Promise<unknown> {
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
	return response.json();
}

async function summarizeOverflowWithModel(
	apiKey: string,
	model: string,
	overflow: LlmContextTurn[],
): Promise<string> {
	const userPrompt = contextConfig.summaryPrompt
		?? 'Summarize key facts, intent, and unresolved tasks in <= 10 bullets. Keep concise.';
	const summaryInput = formatTurnsForSummary(overflow);

	const result = (await fetchOpenRouterJson(apiKey, {
		model,
		messages: [
			{
				role: 'system',
				content: 'You compress conversation history for later context reuse. Output only summary text.',
			},
			{
				role: 'user',
				content: `${userPrompt}\n\nConversation:\n${summaryInput}`,
			},
		],
		reasoning: { enabled: false },
	})) as {
		choices?: Array<{ message?: { content?: unknown } }>;
	};

	const raw = result.choices?.[0]?.message?.content;
	const text = trimToMaxChars(extractFinalText(raw), contextConfig.maxSummaryChars);
	if (!text) {
		throw new Error('Summary response empty');
	}
	return text;
}

async function maybeCompressContext(apiKey: string, model: string): Promise<void> {
	if (recentTurns.length <= contextConfig.maxRecentTurns) return;
	const overflowCount = recentTurns.length - contextConfig.maxRecentTurns;
	const overflow = recentTurns.slice(0, overflowCount);
	recentTurns = recentTurns.slice(overflowCount);

	if (!contextConfig.enableAutoSummarize) {
		contextSummary = buildSummaryFallback(contextSummary, overflow);
		return;
	}

	try {
		const freshSummary = await summarizeOverflowWithModel(apiKey, model, overflow);
		const merged = [contextSummary, freshSummary].filter(Boolean).join('\n');
		contextSummary = trimToMaxChars(merged, contextConfig.maxSummaryChars);
	} catch {
		contextSummary = buildSummaryFallback(contextSummary, overflow);
	}
}

async function appendTurnsToContext(
	apiKey: string,
	model: string,
	turns: LlmContextTurn[],
): Promise<void> {
	for (const turn of turns) {
		if (!turn.text.trim()) continue;
		recentTurns.push(normalizeTurn(turn));
		turnCount += 1;
	}
	await maybeCompressContext(apiKey, model);
}

export interface AudioInferenceOptions {
	apiKey?: string;
	model?: string;
	format?: 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'pcm16';
	prompt?: string;
	reasoningEnabled?: boolean;
	useContext?: boolean;
	clearContextBefore?: boolean;
	clearContextAfter?: boolean;
	contextUserText?: string;
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

export function setLlmContextConfig(partial: Partial<LlmContextConfig>): void {
	contextConfig = {
		...contextConfig,
		...partial,
		maxRecentTurns: Math.max(1, Math.floor(partial.maxRecentTurns ?? contextConfig.maxRecentTurns)),
		maxSummaryChars: Math.max(200, Math.floor(partial.maxSummaryChars ?? contextConfig.maxSummaryChars)),
		maxTurnChars: Math.max(80, Math.floor(partial.maxTurnChars ?? contextConfig.maxTurnChars)),
	};
}

export function getLlmContextState(): { summary: string; recentTurns: LlmContextTurn[]; turnCount: number } {
	return {
		summary: contextSummary,
		recentTurns: recentTurns.map((t) => ({ ...t })),
		turnCount,
	};
}

export function clearLlmContext(): void {
	contextSummary = '';
	recentTurns = [];
	turnCount = 0;
}

export function appendLlmContextTurn(turn: LlmContextTurn): void {
	const normalized = normalizeTurn(turn);
	if (!normalized.text) return;
	recentTurns.push(normalized);
	turnCount += 1;
}

export function buildContextPrompt(userPrompt: string): string {
	const prompt = userPrompt.trim();
	const summaryPart = contextSummary
		? `Conversation summary:\n${contextSummary}\n`
		: 'Conversation summary:\n(none)\n';
	const turnsPart = recentTurns.length
		? recentTurns.map((t) => `- ${t.role}: ${t.text}`).join('\n')
		: '(none)';

	return [
		'Use the context below only when relevant to the current request.',
		summaryPart,
		`Recent turns:\n${turnsPart}`,
		`Current request:\n${prompt}`,
	].join('\n\n');
}

function getRequestPrompt(options: AudioInferenceOptions): { requestPrompt: string; contextUserText: string } {
	const basePrompt = options.prompt ?? 'Please understand this audio and answer concisely.';
	const useContext = options.useContext ?? true;
	if (!useContext) {
		const text = trimToMaxChars(options.contextUserText ?? basePrompt, contextConfig.maxTurnChars);
		return { requestPrompt: basePrompt, contextUserText: text };
	}
	const contextUserText = trimToMaxChars(options.contextUserText ?? basePrompt, contextConfig.maxTurnChars);
	return { requestPrompt: buildContextPrompt(basePrompt), contextUserText };
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
	const reasoningEnabled = options.reasoningEnabled ?? true;
	const useContext = options.useContext ?? true;
	const clearBefore = options.clearContextBefore ?? false;
	const clearAfter = options.clearContextAfter ?? false;
	const audioBase64 = Buffer.isBuffer(audio) ? audio.toString('base64') : audio;

	return runInContextQueue(async () => {
		if (clearBefore) {
			clearLlmContext();
		}
		const { requestPrompt, contextUserText } = getRequestPrompt(options);

		const result = (await fetchOpenRouterJson(apiKey, {
			model,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: requestPrompt },
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
		})) as {
			choices?: Array<{ message?: OpenRouterAssistantMessage }>;
		};

		const message = result.choices?.[0]?.message;
		if (!message) {
			throw new Error('OpenRouter response missing choices[0].message');
		}

		if (useContext) {
			await appendTurnsToContext(apiKey, model, [
				{ role: 'user', text: contextUserText, ts: Date.now() },
				{ role: 'assistant', text: extractFinalText(message.content), ts: Date.now() },
			]);
		}
		if (clearAfter) {
			clearLlmContext();
		}

		return { message, raw: result };
	});
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
	const reasoningEnabled = options.reasoningEnabled ?? true;
	const useContext = options.useContext ?? true;
	const clearBefore = options.clearContextBefore ?? false;
	const clearAfter = options.clearContextAfter ?? false;
	const audioBase64 = Buffer.isBuffer(audio) ? audio.toString('base64') : audio;

	return runInContextQueue(async () => {
		if (clearBefore) {
			clearLlmContext();
		}
		const { requestPrompt, contextUserText } = getRequestPrompt(options);

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
							{ type: 'text', text: requestPrompt },
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
		let finalTextFallback = '';
		let finalReasoningFallback = '';

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
						message?: {
							content?: unknown;
							reasoning_details?: unknown;
						};
					}>;
				};
				try {
					chunk = JSON.parse(data);
				} catch {
					continue;
				}

				const choice = chunk.choices?.[0];
				if (!choice) continue;

				const delta = choice.delta;
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

				const message = choice.message;
				if (message) {
					const finalText = extractFinalText(message.content);
					if (finalText) {
						finalTextFallback = finalText;
					}
					const finalReasoning = extractFinalText(message.reasoning_details);
					if (finalReasoning) {
						finalReasoningFallback = finalReasoning;
					}
				}
			}
		}

		if (!fullText && finalTextFallback) {
			fullText = finalTextFallback;
		}
		if (!fullReasoning && finalReasoningFallback) {
			fullReasoning = finalReasoningFallback;
		}

		if (useContext) {
			await appendTurnsToContext(apiKey, model, [
				{ role: 'user', text: contextUserText, ts: Date.now() },
				{ role: 'assistant', text: fullText, ts: Date.now() },
			]);
		}
		if (clearAfter) {
			clearLlmContext();
		}

		const message: OpenRouterAssistantMessage = {
			role: 'assistant',
			content: fullText,
			reasoning_details: fullReasoning || undefined,
		};
		return { message, raw: { content: fullText, reasoning_details: fullReasoning } };
	});
}
