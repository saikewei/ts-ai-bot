/// <reference types="node" />
import { EventEmitter } from 'events';

export interface ConnectOptions {
  address: string;
  password?: string;
  nickname?: string;
  channel?: string;
  channelPassword?: string;
  identity?: string;
  logLevel?: 'off' | 'commands' | 'packets' | 'udp';
}

export interface DisconnectParams {
  message?: string;
  reasonCode?: number;
}

export interface AudioEventPayload {
  sampleRate: 48000;
  channels: 1;
  samples: 960;
  pcm: Buffer;
}

export interface AudioSpeakerPayload extends AudioEventPayload {
  clientId: number;
}

export type TextMessageTargetType = 'server' | 'channel' | 'client';

export interface SendTextMessageParams {
  target: TextMessageTargetType;
  message: string;
  clientId?: number;
}

export interface TextMessagePayload {
  target: TextMessageTargetType | 'poke';
  targetClientId?: number;
  message: string;
  invoker: {
    id: number;
    name: string;
    uid?: string;
  };
}

export declare class TeamSpeakClient extends EventEmitter {
  constructor();
  connect(options: ConnectOptions): Promise<void>;
  disconnect(params?: DisconnectParams): Promise<void>;
  pushFrame(frame: Buffer | Int16Array): void;
  sendTextMessage(params: SendTextMessageParams): Promise<void>;
  isConnected(): boolean;
  exportIdentity(): string | null;
  getIdentity(): string | null;

  on(event: 'connected', listener: (payload: { serverName?: string }) => void): this;
  on(event: 'reconnecting', listener: (payload: { reason: string }) => void): this;
  on(event: 'disconnected', listener: (payload: { temporary: boolean; reason: string }) => void): this;
  on(event: 'audioMixed', listener: (payload: AudioEventPayload) => void): this;
  on(event: 'audioSpeaker', listener: (payload: AudioSpeakerPayload) => void): this;
  on(event: 'textMessage', listener: (payload: TextMessagePayload) => void): this;
  on(event: 'error', listener: (payload: { code: string; message: string }) => void): this;
}

export declare function decodeBase64PcmToBuffer(b64: string): Buffer;
export declare function encodeBufferToBase64Pcm(buf: Buffer): string;
