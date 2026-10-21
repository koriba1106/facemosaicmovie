// テスト用の偽 Mediabunny（worker.js の処理フローを検証するため。実物の API 形状に合わせている）
export const ALL_FORMATS = ["mp4"]; export const QUALITY_HIGH = { q: "high" };
export const state = { duration: 10, frames: 30, hasAudio: true, decodable: true, encodable: { avc: true, hevc: true, vp9: true, av1: true },
  inputError: null, noVideo: false, discarded: [], execDelay: 0, lastConversion: null, initError: null, recordOutputs: false, width: 640, height: 360, lastCanEncode: [], previewSamples: 14 };
export class BlobSource { constructor(blob) { this.blob = blob; } }
export class ConversionCanceledError extends Error {}
class Track { constructor() { this.displayWidth = state.width; this.displayHeight = state.height; this.rotation = 0; this.codec = "avc"; this.type = "video"; }
  async canDecode() { return state.decodable; } }
export class Input { constructor(o) { this.o = o; this.disposed = false; }
  async getPrimaryVideoTrack() { if (state.inputError) throw new Error(state.inputError); return state.noVideo ? null : new Track(); }
  async getPrimaryAudioTrack() { return state.hasAudio ? { type: "audio" } : null; }
  async computeDuration() { return state.duration; } dispose() { this.disposed = true; } }
class Sample { constructor(t) { this.timestamp = t; this.displayWidth = state.width; this.displayHeight = state.height; this.closed = false; }
  draw(ctx, dx, dy, w, h) { ctx.__paint(); } close() { this.closed = true; } }
export class VideoSampleSink { constructor(track) { this.track = track; }
  async *samples(start, end) { const n = state.previewSamples; for (let i = 0; i < n; i++) yield new Sample(start + i * 0.03); }
  async getSample(t) { return new Sample(t); } }
export class Mp4OutputFormat { constructor(o) { this.o = o; } }
export class BufferTarget { constructor() { this.buffer = null; } }
export class Output { constructor(o) { this.format = o.format; this.target = o.target; } }
export const canEncodeVideo = async (codec, opts) => { state.lastCanEncode.push([codec, opts]); return !!state.encodable[codec]; };
export const Conversion = { async init(opts) {
  if (state.initError) throw new Error(state.initError);
  let canceled = false;
  const conv = { isValid: true, discardedTracks: state.discarded, onProgress: null, opts,
    async execute() {
      const n = state.frames;
      for (let i = 0; i < n; i++) {
        if (canceled) throw new ConversionCanceledError("canceled");
        const out = await opts.video.process(new Sample(i / 30));
        conv.outputs = (conv.outputs || 0) + 1; conv.lastOut = out; if (state.recordOutputs) (conv.outs ||= []).push(out);
        if (conv.onProgress) conv.onProgress((i + 1) / n, i / 30);
        if (state.execDelay) await new Promise((r) => setTimeout(r, state.execDelay));
      }
      if (canceled) throw new ConversionCanceledError("canceled");
      opts.output.target.buffer = new ArrayBuffer(123456);
    },
    async cancel() { canceled = true; } };
  state.lastConversion = conv; return conv; } };
