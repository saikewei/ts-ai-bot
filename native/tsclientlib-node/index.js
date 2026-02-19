'use strict';

const { EventEmitter } = require('events');
const binding = require('./index.node');

class TeamSpeakClient extends EventEmitter {
  constructor() {
    super();
    this._native = new binding.TeamSpeakClient();
    this._native.onEvent((err, packed) => {
      try {
        if (err) {
          this.emit('error', { code: 'E_NATIVE_EVENT', message: String(err) });
          return;
        }

        let eventName = '';
        let payload = {};

        if (typeof packed === 'string') {
          const obj = JSON.parse(packed);
          eventName = obj?.name ?? '';
          payload = obj?.payload ? JSON.parse(obj.payload) : {};
        }

        if (!eventName) return;
        if (payload && typeof payload.pcm === 'string') {
          payload.pcm = Buffer.from(payload.pcm, 'base64');
        }
        this.emit(eventName, payload);
      } catch (err) {
        this.emit('error', { code: 'E_JS_EVENT', message: String(err) });
      }
    });
  }

  async connect(options) {
    const normalized = {
      address: options.address,
      password: options.password,
      nickname: options.nickname,
      channel: options.channel,
      channel_password: options.channelPassword,
      identity: options.identity,
      log_level: options.logLevel,
    };
    await this._native.connect(normalized);
  }

  async disconnect(params) {
    if (!params) {
      await this._native.disconnect(undefined);
      return;
    }
    await this._native.disconnect({
      message: params.message,
      reason_code: params.reasonCode,
    });
  }

  pushFrame(frame) {
    if (frame instanceof Int16Array) {
      this._native.pushFrame(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      return;
    }
    this._native.pushFrame(frame);
  }

  isConnected() {
    return this._native.isConnected();
  }

  exportIdentity() {
    return this._native.exportIdentity();
  }

  getIdentity() {
    return this._native.getIdentity();
  }
}

module.exports = {
  TeamSpeakClient,
  decodeBase64PcmToBuffer: binding.decodeBase64PcmToBuffer,
  encodeBufferToBase64Pcm: binding.encodeBufferToBase64Pcm,
};
