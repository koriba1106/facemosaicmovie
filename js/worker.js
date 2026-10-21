/* FaceMosaic Browser - worker.js（クラシック Worker）
 * 重い処理（OpenCV.js による検出・モザイク、Mediabunny によるデコード/エンコード）は全てここで行い、
 * 画面（メインスレッド）は固まらない。動画データはこの端末の外へは一切送信しない。
 *
 * セキュリティ: 受け取るメッセージは必ず FMCore.validateRequest() で検証してから処理する。
 *               使用するモデルは SHA-256 が固定値と一致するものだけを読み込む。
 */
"use strict";
importScripts("core.js", "pipeline.js", "../vendor/opencv.js");

const C = FMCore.C;
let cv = null;              // OpenCV.js
let mb = null;              // Mediabunny
let detector = null;        // {primary, coarse}（dynamic-input YuNet）
let busy = false;           // 書き出し中
let currentConversion = null;
let cancelRequested = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const even = (n) => Math.max(2, Math.floor(n) - (Math.floor(n) % 2));

function errText(e) {
  if (e == null) return "不明なエラー";
  if (typeof e === "number") return "内部エラー(code " + e + ")";   // OpenCV.js は例外をポインタ値で投げることがある
  return String(e.message || e);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- 初期化
async function ensureCv() {
  if (cv) return cv;
  let m = self.cv;
  if (typeof m === "function") m = m();
  if (m && typeof m.then === "function") m = await m;
  if (!m || !m.Mat) {
    await new Promise((resolve) => { m.onRuntimeInitialized = resolve; });
  }
  cv = m;
  return cv;
}

async function ensureMediabunny() {
  if (mb) return mb;
  mb = await import("../vendor/mediabunny.min.js");     // 動的 import（クラシック Worker でも可）
  return mb;
}

async function handleInit({ modelBytes }) {
  // 想定外のモデル（差し替え・改ざん・別バージョン）は、解析器に渡す前に拒否する
  if (modelBytes.byteLength !== C.MODEL_SIZE || (await sha256Hex(modelBytes)) !== C.MODEL_SHA256) {
    throw new Error(`モデルファイルが想定のもの（${C.MODEL_FILENAME}）と一致しません。正しいファイルを配置してください。`);
  }
  await ensureCv();
  await ensureMediabunny();
  if (detector) FMPipeline.disposeDetector(detector);
  detector = FMPipeline.createDynamicDetector(cv, FMCore, modelBytes);
  post({ type: "ready" });
}

function requireReady() {
  if (!detector) throw new Error("顔認識エンジンが準備できていません。");
}

// ---------------------------------------------------------------- 入力の解析
async function openInput(file) {
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  let vtrack;
  try {
    vtrack = await input.getPrimaryVideoTrack();
  } catch (e) {
    input.dispose();
    throw new Error("この形式の動画は読み込めません（mp4 / mov / webm / mkv に対応）。");
  }
  if (!vtrack) { input.dispose(); throw new Error("映像トラックが見つかりません。"); }
  if (!(vtrack.displayWidth > 0 && vtrack.displayHeight > 0) || vtrack.displayWidth * vtrack.displayHeight > C.MAX_PIXELS) {
    input.dispose();
    throw new Error(`解像度が大きすぎます（${vtrack.displayWidth}×${vtrack.displayHeight}）。4K（約830万画素）以下の動画に対応しています。`);
  }
  return { input, vtrack };
}

async function handleInspect({ file, id }) {
  const { input, vtrack } = await openInput(file);
  try {
    const decodable = await vtrack.canDecode();
    const duration = await input.computeDuration();
    const atrack = await input.getPrimaryAudioTrack();
    post({
      type: "inspected", id,
      info: {
        width: vtrack.displayWidth, height: vtrack.displayHeight,
        duration, codec: vtrack.codec, rotation: vtrack.rotation, hasAudio: !!atrack, decodable,
      },
    });
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------- フレーム処理
/** VideoSample を RGBA バイト列として取り出す */
function sampleToRgba(sample, scratch, w, h) {
  sample.draw(scratch.ctx, 0, 0, w, h);
  return scratch.ctx.getImageData(0, 0, w, h);
}

function makeScratch(w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return { canvas, ctx, w, h };
}

// ---------------------------------------------------------------- プレビュー
async function handlePreview({ file, time, id, accuracy, regions }) {
  if (busy) { post({ type: "preview-skipped", id }); return; }
  requireReady();
  const { input, vtrack } = await openInput(file);
  let pipe = null;
  try {
    if (!(await vtrack.canDecode())) throw new Error("この動画のコーデックはブラウザでデコードできません。");
    const W = even(vtrack.displayWidth), H = even(vtrack.displayHeight);
    pipe = new FMPipeline.FacePipeline(cv, FMCore, detector);
    const scratch = makeScratch(W, H);
    const sink = new mb.VideoSampleSink(vtrack);
    const duration = await input.computeDuration();
    const t = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)));
    const warmSec = 0.5;                                    // 約12〜15フレームの助走で追跡状態を作る
    const dim = FMCore.detectDim(accuracy, true);
    let count = 0, lastTs = t;                              // lastTs: 実際に表示するフレームの時刻（手動範囲の判定に使う）

    for await (const sample of sink.samples(Math.max(0, t - warmSec), t + 0.0005)) {
      try {
        const img = sampleToRgba(sample, scratch, W, H);
        pipe.processFrame(img.data, W, H, dim, false);      // 助走: 追跡のみ更新
        lastTs = sample.timestamp;
        count++;
      } finally {
        sample.close();
      }
    }
    if (count === 0) {                                      // 範囲に1枚も無い場合は直近フレームで代用
      const s = await sink.getSample(t);
      if (!s) throw new Error("指定位置のフレームを取得できませんでした。");
      try {
        const img = sampleToRgba(s, scratch, W, H);
        pipe.processFrame(img.data, W, H, dim, false);
        lastTs = s.timestamp;
      } finally { s.close(); }
    }
    // 最終フレームのみ、顔モザイクと、そのフレームの時刻に有効な手動範囲のモザイクを適用して取り出す
    const rects = FMCore.activeRegions(regions, lastTs).map((r) => FMCore.regionToRect(r, W, H));
    const out = pipe.renderCurrent(rects);

    const outCanvas = new OffscreenCanvas(W, H);
    outCanvas.getContext("2d").putImageData(new ImageData(out, W, H), 0, 0);
    const maxW = 960, scale = Math.min(1, maxW / W);
    let blobCanvas = outCanvas;
    if (scale < 1) {
      blobCanvas = new OffscreenCanvas(Math.round(W * scale), Math.round(H * scale));
      blobCanvas.getContext("2d").drawImage(outCanvas, 0, 0, blobCanvas.width, blobCanvas.height);
    }
    const blob = await blobCanvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    post({ type: "preview", id, blob, frames: count, frameTime: lastTs });
  } finally {
    if (pipe) pipe.dispose();
    input.dispose();
  }
}

// ---------------------------------------------------------------- 書き出し
async function pickCodec(order, W, H, bitrate) {
  for (const c of order) {
    try {
      if (await mb.canEncodeVideo(c, { width: W, height: H, bitrate })) return c;
    } catch (e) { /* 次の候補へ */ }
  }
  return null;
}

async function handleExport({ file, quality, maxSeconds, accuracy, regions }) {
  if (busy) throw new Error("すでに処理中です。");
  requireReady();
  busy = true; cancelRequested = false;
  let input = null, pipe = null;
  try {
    post({ type: "progress", value: 1, text: "動画を解析しています…" });
    const opened = await openInput(file);
    input = opened.input;
    const vtrack = opened.vtrack;
    if (!(await vtrack.canDecode())) throw new Error("この動画のコーデックはブラウザでデコードできません。mp4(H.264) などに変換してお試しください。");

    const W = even(vtrack.displayWidth), H = even(vtrack.displayHeight);
    const fullDuration = await input.computeDuration();
    const duration = maxSeconds ? Math.min(maxSeconds, fullDuration) : fullDuration;
    const compact = quality === "compact";

    const bitrate = compact ? FMCore.calculateCompactBitrate(file.size, duration) : mb.QUALITY_HIGH;
    const order = compact ? ["hevc", "avc", "vp9"] : ["avc", "vp9", "av1"];
    const codec = await pickCodec(order, W, H, bitrate);
    if (!codec) throw new Error("このブラウザは動画のエンコードに対応していません。最新の Chrome または Edge をお使いください。");

    post({ type: "progress", value: 2, text: "顔検出エンジンを準備しています…" });
    pipe = new FMPipeline.FacePipeline(cv, FMCore, detector);
    const scratch = makeScratch(W, H);
    const dim = FMCore.detectDim(accuracy, false);
    let frames = 0, detectFailures = 0, consecutive = 0;
    const warnings = [];

    const process = async (sample) => {
      const w = even(sample.displayWidth), h = even(sample.displayHeight);
      if (w * h > C.MAX_PIXELS) throw new Error("フレームの解像度が大きすぎます。");
      const sc = (w === scratch.w && h === scratch.h) ? scratch : makeScratch(w, h);
      const img = sampleToRgba(sample, sc, w, h);
      // このフレームの時刻に有効な手動範囲（プレビューと同じ判定）
      const rects = FMCore.activeRegions(regions, sample.timestamp).map((r) => FMCore.regionToRect(r, w, h));
      const res = pipe.processFrame(img.data, w, h, dim, true, rects);
      if (res.detectError) {
        // 1フレームの検出失敗では止めない（追跡は予測位置で続き、モザイクも掛かる）。連続して失敗する場合は中止
        detectFailures++; consecutive++;
        if (consecutive >= 30) throw new Error("顔検出が連続して失敗しました: " + errText(res.detectError));
      } else {
        consecutive = 0;
      }
      frames++;
      const out = new OffscreenCanvas(w, h);                // 返却用は毎回新規（エンコーダが保持しても安全）
      out.getContext("2d").putImageData(img, 0, 0);
      return out;
    };

    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({
      input, output,
      ...(maxSeconds ? { trim: { start: 0, end: maxSeconds } } : {}),
      video: {
        codec, bitrate, forceTranscode: true, allowTransformationMetadata: false,
        processedWidth: W, processedHeight: H, process,
      },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error("この動画は変換できません。" + conversion.discardedTracks.map((d) => d.reason).join(", "));
    }
    for (const d of conversion.discardedTracks) {
      if (d.track && d.track.type === "audio") warnings.push("音声トラックを出力に含められませんでした（" + d.reason + "）。映像のみで出力します。");
    }
    currentConversion = conversion;

    const startedAt = Date.now();
    let lastPost = 0;
    conversion.onProgress = (p) => {
      const now = Date.now();
      if (now - lastPost < 120) return;
      lastPost = now;
      const remain = FMCore.estimateRemaining((now - startedAt) / 1000, p);
      post({
        type: "progress", value: Math.min(97, 3 + p * 94),
        text: `顔検出・モザイク処理中… ${frames}フレーム処理済み` + (remain === null ? "" : ` / 残り約${FMCore.formatDuration(remain)}`),
      });
    };
    post({ type: "progress", value: 3, text: "顔検出・モザイク処理を開始しました…" });

    try {
      await conversion.execute();
    } catch (e) {
      if (cancelRequested || (mb.ConversionCanceledError && e instanceof mb.ConversionCanceledError)) { post({ type: "canceled" }); return; }
      throw e;
    }
    if (cancelRequested) { post({ type: "canceled" }); return; }

    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength === 0) throw new Error("出力ファイルを生成できませんでした。");
    if (detectFailures > 0) warnings.push(`${detectFailures}フレームで顔検出に失敗しました（直前までの追跡位置でモザイクを継続）。`);
    post({
      type: "done", buffer, codec, frames, manualCount: regions.length,
      size: buffer.byteLength, ratioPct: Math.round((buffer.byteLength / Math.max(1, file.size)) * 1000) / 10,
      warnings, hasAudio: !(warnings.some((w) => w.startsWith("音声"))),
    }, [buffer]);
  } finally {
    currentConversion = null;
    if (pipe) pipe.dispose();
    if (input) input.dispose();
    busy = false;
  }
}

// ---------------------------------------------------------------- 診断（selfcheck.html 用）
async function handleDetectImage({ bitmap, id }) {
  requireReady();
  const W = even(bitmap.width), H = even(bitmap.height);
  const scratch = makeScratch(W, H);
  scratch.ctx.drawImage(bitmap, 0, 0, W, H);
  const img = scratch.ctx.getImageData(0, 0, W, H);
  const before = img.data.slice();
  const pipe = new FMPipeline.FacePipeline(cv, FMCore, detector);
  try {
    const dim = FMCore.detectDim("high", false);
    // 2フレーム分流して、確定トラックにモザイクが掛かるところまで確認する
    pipe.processFrame(img.data, W, H, dim, false);
    const info = pipe.processFrame(img.data, W, H, dim, true);
    let changed = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] !== before[i] || img.data[i + 1] !== before[i + 1] || img.data[i + 2] !== before[i + 2]) changed++;
    const boxes = pipe.tracks.map((t) => t.box.map((v) => Math.round(v)));
    scratch.ctx.putImageData(img, 0, 0);
    const blob = await scratch.canvas.convertToBlob({ type: "image/png" });
    post({ type: "detected", id, faces: info.faces, tracks: info.tracks, changedPixels: changed, boxes, blob });
  } finally {
    pipe.dispose();
  }
}

// ---------------------------------------------------------------- メッセージ処理
self.onmessage = async (ev) => {
  let msg;
  try {
    msg = FMCore.validateRequest(ev.data);                  // 型・範囲・選択肢を検証してから処理に入る
  } catch (e) {
    const t = ev && ev.data && typeof ev.data.type === "string" ? ev.data.type : undefined;
    post({ type: "error", for: t, id: ev && ev.data ? ev.data.id : undefined, message: errText(e) });
    return;
  }
  try {
    switch (msg.type) {
      case "init": await handleInit(msg); break;
      case "inspect": await handleInspect(msg); break;
      case "preview": await handlePreview(msg); break;
      case "export": await handleExport(msg); break;
      case "detect-image": await handleDetectImage(msg); break;
      case "cancel":
        cancelRequested = true;
        if (currentConversion) { try { await currentConversion.cancel(); } catch (e) { /* 既に終了 */ } }
        break;
      default: break;
    }
  } catch (e) {
    post({ type: "error", for: msg.type, id: msg.id, message: errText(e) });
  }
};
