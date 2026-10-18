// worker.js の処理フロー検証。実 OpenCV.js + 実 pipeline/core。YuNet・Mediabunny・Canvas のみ偽物。
// 実行: node --expose-gc tests/test_worker.js
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- Worker 環境の模擬 ----
  const outbox = [];
  globalThis.self = globalThis;
  globalThis.postMessage = (m, transfer) => outbox.push({ m, transfer });
  globalThis.importScripts = (...files) => { for (const f of files) {
    if (f === "core.js") self.FMCore = require(path.join(ROOT, "js/core.js"));
    else if (f === "pipeline.js") self.FMPipeline = require(path.join(ROOT, "js/pipeline.js"));
    else if (f.endsWith("opencv.js")) self.cv = require(path.join(ROOT, "vendor/opencv.js"));
    else throw new Error("unknown importScripts " + f); } };
  class FakeCtx { constructor(c) { this.canvas = c; this._canvas = c; }
    __paint() { const d = this._canvas._data; for (let i = 0; i < d.length; i += 4) { const p = i / 4; d[i] = p * 7 & 255; d[i + 1] = (p / this._canvas.width | 0) * 3 & 255; d[i + 2] = 90; d[i + 3] = 255; } }
    drawImage(src) { if (src && src._data) this._canvas._data.set(src._data.subarray(0, this._canvas._data.length)); else this.__paint(); }
    getImageData(x, y, w, h) { return new ImageData(this._canvas._data.slice(), w, h); }
    putImageData(img) { this._canvas._data.set(img.data); this._canvas.lastPut = img.data; } }
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; this._data = new Uint8ClampedArray(w * h * 4); this._ctx = new FakeCtx(this); }
    getContext() { return this._ctx; } async convertToBlob(o) { return { size: this._data.length, type: (o && o.type) || "image/png", w: this.width, h: this.height }; } };

  // worker.js を読み込む（動的 import の指定先だけ偽 Mediabunny に差し替える）
  const src = fs.readFileSync(path.join(ROOT, "js/worker.js"), "utf8");
  if (!src.includes('import("../vendor/mediabunny.min.js")')) throw new Error("worker.js の import 指定が想定と違う");
  const mockUrl = "file://" + path.join(__dirname, "mock_mediabunny.mjs");
  const tmp = path.join(os.tmpdir(), "fm_worker_under_test.cjs");
  fs.writeFileSync(tmp, src.replace('import("../vendor/mediabunny.min.js")', `import(${JSON.stringify(mockUrl)})`));
  const origImport = globalThis.importScripts; globalThis.importScripts = (...f) => origImport(...f.map((x) => x.replace("../vendor/", "")));
  require(tmp);
  const mock = await import(mockUrl); const st = mock.state;

  let cv = await self.cv; if (cv && typeof cv.then === "function") cv = await cv;
  const FM = self.FMCore, C = FM.C;

  // 偽 YuNet（FaceDetectorYN と同形式の出力）。顔は画面中央付近（有効領域に対する比率）
  class FakeYuNet { constructor() { this.size = null; this.sizes = []; this.calls = 0; this.failEvery = 0; this.failAlways = false; this.valid = [640, 360]; }
    setInputSize(s) { this.size = [s.width, s.height]; this.sizes.push(this.size.join("x")); }
    detect(img, out) { this.calls++;
      if (this.failAlways || (this.failEvery && this.calls % this.failEvery === 0)) throw new Error("detector boom");
      const [vw, vh] = this.valid, x = vw * 0.40, y = vh * 0.28, w = vw * 0.14, h = vw * 0.15;
      const arr = [x, y, w, h, x + w * .3, y + h * .38, x + w * .7, y + h * .38, x + w * .5, y + h * .58, x + w * .35, y + h * .78, x + w * .65, y + h * .78, 0.92];
      const m = cv.matFromArray(1, 15, cv.CV_32F, arr); m.copyTo(out); m.delete(); return 1; } }
  const P = new FakeYuNet(), Q = new FakeYuNet(); const fakeDet = { primary: { det: P, size: null }, coarse: { det: new FakeYuNet(), size: null } };
  fakeDet.coarse.det.detect = (img, out) => 0;
  const createCalls = [];
  self.FMPipeline.createDynamicDetector = (cvx, core, bytes) => { createCalls.push(bytes.byteLength); return fakeDet; };
  const setValid = (w, h, md) => { const d = FM.detectionSize(w, h, md); P.valid = [d.dw, d.dh]; };

  const send = async (msg) => { const n = outbox.length; await self.onmessage({ data: msg }); return outbox.slice(n).map((o) => o.m); };
  const types = (ms) => ms.map((m) => m.type);
  const FILE = { name: "a.mp4", size: 5_000_000, slice() { return this; } };
  const MODEL = fs.readFileSync(path.join(ROOT, "models", C.MODEL_FILENAME)); const modelAB = () => MODEL.buffer.slice(MODEL.byteOffset, MODEL.byteOffset + MODEL.byteLength);

  // ---- init: モデルの固定ハッシュ ----
  const tampered = new Uint8Array(modelAB()); tampered[1000] ^= 1;
  let ms = await send({ type: "init", modelBytes: tampered.buffer });
  check("init: 1バイトでも改変されたモデルは、解析器に渡す前に拒否する", ms[0].type === "error" && ms[0].for === "init" && ms[0].message.includes("一致しません") && createCalls.length === 0, JSON.stringify(ms[0]));
  const other = new Uint8Array(C.MODEL_SIZE); ms = await send({ type: "init", modelBytes: other.buffer });
  check("init: 同じサイズの別データも拒否(サイズだけでなくハッシュで判定)", ms[0].type === "error" && createCalls.length === 0);
  ms = await send({ type: "init", modelBytes: new ArrayBuffer(10) });
  check("init: 極端に小さいデータは形式チェックで拒否", ms[0].type === "error" && ms[0].message.includes("サイズ"));
  ms = await send({ type: "init", modelBytes: "not a buffer" });
  check("init: ArrayBuffer でない値は拒否", ms[0].type === "error" && ms[0].message.includes("形式"));
  ms = await send({ type: "inspect", file: FILE, id: 1 }); check("エンジン未準備のまま inspect しても Worker は落ちない(通常の解析は可能)", ms[0].type === "inspected" || ms[0].type === "error");
  ms = await send({ type: "export", file: FILE, quality: "standard", accuracy: "high" });
  check("エンジン未準備での export は明確なエラー", ms.some((m) => m.type === "error" && m.message.includes("準備")), JSON.stringify(ms));
  ms = await send({ type: "init", modelBytes: modelAB() });
  check("init: 正しいモデルで OpenCV.js・Mediabunny を読み込み、検出器を作成して ready", types(ms).join() === "ready" && createCalls.length === 1 && createCalls[0] === C.MODEL_SIZE, JSON.stringify(types(ms)));

  // ---- 入力検証（攻撃的なメッセージ） ----
  const rejects = async (label, msg, needle) => { const r = await send(msg); const e = r.find((m) => m.type === "error"); check(`検証: ${label}`, !!e && (!needle || e.message.includes(needle)) && !types(r).includes("done") && !types(r).includes("progress"), JSON.stringify(r).slice(0, 160)); };
  await rejects("未知のメッセージ型", { type: "eval", code: "1" }, "未知");
  await rejects("型が文字列でない", { type: 123 }, "不正");
  await rejects("null", null, "不正");
  await rejects("export の品質が未知の値", { type: "export", file: FILE, quality: "evil" }, "品質");
  await rejects("export の file が普通のオブジェクト(slice 無し)", { type: "export", file: { size: 10 }, quality: "standard" }, "動画");
  await rejects("export の file が空(size 0)", { type: "export", file: { size: 0, slice() {} }, quality: "standard" }, "動画");
  await rejects("export の file が上限(4GB)超", { type: "export", file: { size: 5 * 1024 ** 3, slice() {} }, quality: "standard" }, "動画");
  await rejects("export の maxSeconds が負", { type: "export", file: FILE, quality: "standard", maxSeconds: -1 }, "秒数");
  await rejects("export の maxSeconds が巨大", { type: "export", file: FILE, quality: "standard", maxSeconds: 1e9 }, "秒数");
  await rejects("export の maxSeconds が NaN", { type: "export", file: FILE, quality: "standard", maxSeconds: NaN }, "秒数");
  await rejects("preview の time が文字列", { type: "preview", file: FILE, time: "5", id: 1 }, "時刻");
  await rejects("preview の time が Infinity", { type: "preview", file: FILE, time: Infinity, id: 1 }, "時刻");
  await rejects("id がオブジェクト", { type: "inspect", file: FILE, id: { a: 1 } }, "ID");
  await rejects("detect-image の画像が巨大(画素数上限超)", { type: "detect-image", bitmap: { width: 20000, height: 20000 }, id: 1 }, "画像");
  const odd = await send({ type: "export", file: FILE, quality: "standard", accuracy: "'; drop table", maxSeconds: undefined });
  check("検証: 未知の accuracy は 'high' に丸めて処理(拒否はしないが危険な値は使わない)", types(odd).includes("done"));
  const acc = FM.validateRequest({ type: "export", file: FILE, quality: "standard", accuracy: "bogus" });
  check("検証: validateRequest は正規化した値だけを返す(余計なフィールドを引き継がない)", acc.accuracy === "high" && !("evil" in FM.validateRequest({ type: "cancel", evil: 1 })) && Object.keys(FM.validateRequest({ type: "cancel", evil: 1 })).join() === "type,id");

  // ---- inspect / 解像度の上限 ----
  ms = await send({ type: "inspect", file: FILE, id: 7 });
  check("inspect: 幅・高さ・長さ・コーデック・音声・デコード可否を返す", ms[0].type === "inspected" && ms[0].id === 7 && ms[0].info.width === 640 && ms[0].info.duration === 10 && ms[0].info.hasAudio && ms[0].info.decodable && ms[0].info.codec === "avc", JSON.stringify(ms[0]));
  st.hasAudio = false; ms = await send({ type: "inspect", file: FILE, id: 8 }); st.hasAudio = true;
  check("inspect: 音声なしを検出", ms[0].info.hasAudio === false);
  st.noVideo = true; ms = await send({ type: "inspect", file: FILE, id: 9 }); st.noVideo = false;
  check("inspect: 映像トラック無しは明確なエラー", ms[0].type === "error" && ms[0].message.includes("映像トラック") && ms[0].for === "inspect" && ms[0].id === 9, JSON.stringify(ms[0]));
  st.inputError = "bad container"; ms = await send({ type: "inspect", file: FILE, id: 10 }); st.inputError = null;
  check("inspect: 読み込めない形式は案内付きエラー", ms[0].type === "error" && ms[0].message.includes("対応"), JSON.stringify(ms[0]));
  st.width = 5000; st.height = 3000;
  for (const t of ["inspect", "preview", "export"]) { ms = await send({ type: t, file: FILE, id: 11, time: 1, quality: "standard" }); check(`解像度が上限(約920万画素)を超える動画は ${t} で拒否`, ms.some((m) => m.type === "error" && m.message.includes("解像度")) && !types(ms).includes("done"), JSON.stringify(ms).slice(0, 120)); }
  st.width = 640; st.height = 360;

  // ---- preview ----
  P.calls = 0; setValid(640, 360, 640);
  ms = await send({ type: "preview", file: FILE, time: 5, id: 21, accuracy: "high" });
  check("preview: JPEG を返す(id一致・助走フレームを処理)", ms[0].type === "preview" && ms[0].id === 21 && ms[0].blob.type === "image/jpeg" && ms[0].frames === st.previewSamples && P.calls === st.previewSamples, JSON.stringify(ms[0]) + " calls=" + P.calls);
  st.previewSamples = 0; ms = await send({ type: "preview", file: FILE, time: 0, id: 22 }); st.previewSamples = 14;
  check("preview: 範囲に1枚も無くても getSample で代用して返す", ms[0].type === "preview" && ms[0].blob, JSON.stringify(ms[0]));
  ms = await send({ type: "preview", file: FILE, time: 9999, id: 23 });
  check("preview: 動画長を超える時刻でもエラーにならない", ms[0].type === "preview", JSON.stringify(ms[0]));
  st.decodable = false; ms = await send({ type: "preview", file: FILE, time: 1, id: 24 }); st.decodable = true;
  check("preview: デコード不可は明確なエラー", ms[0].type === "error" && ms[0].for === "preview" && ms[0].message.includes("デコード"), JSON.stringify(ms[0]));

  // ---- 検出精度: 検出解像度の切り替え(1280x720) ----
  st.width = 1280; st.height = 720;
  const dimsOf = async (accuracy, kind) => { P.sizes.length = 0; fakeDet.primary.size = null; fakeDet.coarse.size = null; setValid(1280, 720, FM.detectDim(accuracy, kind === "preview")); await send(kind === "preview" ? { type: "preview", file: FILE, time: 3, id: 31, accuracy } : { type: "export", file: FILE, quality: "standard", accuracy }); return P.sizes[0]; };
  check("export: 高精度は 960 → 入力 960x544、高速は 640 → 640x384 で推論", (await dimsOf("high", "export")) === "960x544" && (await dimsOf("fast", "export")) === "640x384", "");
  check("preview: 高精度は 640 → 640x384、高速は 480 → 480x288 で推論", (await dimsOf("high", "preview")) === "640x384" && (await dimsOf("fast", "preview")) === "480x288", "");
  st.width = 640; st.height = 360;

  // ---- export（標準） ----
  P.calls = 0; setValid(640, 360, 960); st.lastCanEncode = [];
  ms = await send({ type: "export", file: FILE, quality: "standard", accuracy: "high" });
  const prog = ms.filter((m) => m.type === "progress").map((m) => m.value), done = ms.find((m) => m.type === "done");
  check("export: done を返し、全フレーム(30)を処理", !!done && done.frames === 30 && P.calls === 30, JSON.stringify(types(ms).slice(-3)));
  check("export: 進捗は範囲内で単調増加", prog.length > 3 && prog.every((v, i) => i === 0 || v >= prog[i - 1]) && prog[0] >= 1 && prog[prog.length - 1] <= 97, prog.join());
  check("export: 出力バッファを転送(transfer)し、サイズ・比率を返す", done.size === 123456 && done.buffer.byteLength === 123456 && Math.abs(done.ratioPct - 2.5) < 0.1 && outbox[outbox.length - 1].transfer[0] === done.buffer, done.ratioPct);
  check("export: 標準画質は H.264(avc) を最初に選ぶ", done.codec === "avc" && st.lastCanEncode[0][0] === "avc");
  const o = st.lastConversion.opts;
  check("export: 変換設定(強制再エンコード/回転は焼き込み/処理後サイズ/faststart)", o.video.forceTranscode === true && o.video.allowTransformationMetadata === false && o.video.processedWidth === 640 && o.video.processedHeight === 360 && o.output.format.o.fastStart === "in-memory" && !("trim" in o));
  check("export: 標準は高品質プリセット", o.video.bitrate === mock.QUALITY_HIGH);
  const outCanvas = st.lastConversion.lastOut;
  check("export: process は新しい OffscreenCanvas を返す(エンコーダが保持しても安全)", outCanvas instanceof OffscreenCanvas && outCanvas.width === 640 && outCanvas.height === 360);
  const ref = new OffscreenCanvas(640, 360); ref._ctx.__paint(); const mos = outCanvas.lastPut;
  let inside = 0, outside = 0; for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) { const i = (y * 640 + x) * 4; const ch = mos[i] !== ref._data[i] || mos[i + 1] !== ref._data[i + 1]; const ins = x >= 240 && x < 372 && y >= 80 && y < 215; if (ch) ins ? inside++ : outside++; }
  check(`export: 返却フレームの顔領域だけモザイク(領域内${inside}画素/領域外${outside})`, inside > 2000 && outside < 200, `${inside}/${outside}`);
  check("export: 変換後は busy が解除される(続けて2回目を実行できる)", types(await send({ type: "export", file: FILE, quality: "standard" })).includes("done"));

  // ---- 残り時間の表示 ----
  st.execDelay = 130; ms = await send({ type: "export", file: FILE, quality: "standard" }); st.execDelay = 0;
  const etaMsgs = ms.filter((m) => m.type === "progress" && m.text.includes("残り約"));
  check(`export: 処理が数秒続くと「残り約…」を進捗に表示(${etaMsgs.length}回)`, etaMsgs.length > 0 && /残り約\d+(秒|分)/.test(etaMsgs[0].text), JSON.stringify(ms.filter((m) => m.type === "progress").slice(-2)));

  // ---- export（軽量・コーデック選択・ビットレート） ----
  st.lastCanEncode = []; st.encodable.hevc = true; ms = await send({ type: "export", file: FILE, quality: "compact" });
  const expectBps = FM.calculateCompactBitrate(FILE.size, st.duration);
  check("軽量: HEVC を最優先し、ビットレートは目標0.40倍の計算式どおり", ms.find((m) => m.type === "done").codec === "hevc" && st.lastConversion.opts.video.bitrate === expectBps && st.lastCanEncode[0][0] === "hevc", `${st.lastConversion.opts.video.bitrate} vs ${expectBps}`);
  st.encodable.hevc = false; ms = await send({ type: "export", file: FILE, quality: "compact" }); st.encodable.hevc = true;
  check("軽量: HEVC不可なら H.264 へフォールバック", ms.find((m) => m.type === "done").codec === "avc");
  st.encodable.avc = false; ms = await send({ type: "export", file: FILE, quality: "standard" }); st.encodable.avc = true;
  check("標準: H.264不可なら VP9 へフォールバック", ms.find((m) => m.type === "done").codec === "vp9");
  const saved = { ...st.encodable }; for (const k in st.encodable) st.encodable[k] = false;
  ms = await send({ type: "export", file: FILE, quality: "standard" }); Object.assign(st.encodable, saved);
  const e1 = ms.find((m) => m.type === "error");
  check("全コーデック不可: 『Chrome/Edge を』案内するエラー", e1 && e1.for === "export" && e1.message.includes("エンコード") && e1.message.includes("Chrome"), JSON.stringify(e1));
  check("エラー後も busy は解除される", types(await send({ type: "export", file: FILE, quality: "standard" })).includes("done"));

  // ---- 異常: デコード不可 / 音声破棄 / 検出失敗 ----
  st.decodable = false; ms = await send({ type: "export", file: FILE, quality: "standard" }); st.decodable = true;
  check("export: デコード不可は mp4 変換を案内するエラー", ms.find((m) => m.type === "error").message.includes("変換"));
  st.discarded = [{ track: { type: "audio" }, reason: "undecodable_source_codec" }];
  ms = await send({ type: "export", file: FILE, quality: "standard" }); st.discarded = [];
  const dw = ms.find((m) => m.type === "done");
  check("音声トラックが破棄された場合は警告に理由を含める", dw.warnings.some((w) => w.includes("音声") && w.includes("undecodable_source_codec")) && dw.hasAudio === false, JSON.stringify(dw.warnings));
  P.calls = 0; P.failEvery = 5; ms = await send({ type: "export", file: FILE, quality: "standard" }); P.failEvery = 0;
  const dd = ms.find((m) => m.type === "done");
  check("検出が散発的に失敗しても書き出しは継続し、失敗数を警告", dd && dd.frames === 30 && dd.warnings.some((w) => w.includes("6フレーム")), JSON.stringify(dd && dd.warnings));
  P.calls = 0; P.failAlways = true; st.frames = 60; ms = await send({ type: "export", file: FILE, quality: "standard" }); P.failAlways = false; st.frames = 30;
  const ef = ms.find((m) => m.type === "error");
  check("検出が連続30回失敗したら中止(無限に続けない)", ef && ef.message.includes("連続"), JSON.stringify(ef));

  // ---- キャンセル・排他 ----
  st.execDelay = 25; st.frames = 200;
  const running = send({ type: "export", file: FILE, quality: "standard" });
  await sleep(150);
  const second = await send({ type: "export", file: FILE, quality: "standard" });
  check("処理中の2重 export はエラー(状態を壊さない)", second[0].type === "error" && second[0].message.includes("処理中"), JSON.stringify(second[0]));
  const pv = await send({ type: "preview", file: FILE, time: 1, id: 99 });
  check("処理中のプレビュー要求は破棄(preview-skipped)", pv[0].type === "preview-skipped" && pv[0].id === 99, JSON.stringify(pv[0]));
  await send({ type: "cancel" });
  const rmsgs = await running;
  check("cancel: canceled を返し、途中で停止(200フレーム全部は処理しない)", types(rmsgs).includes("canceled") && !types(rmsgs).includes("done") && st.lastConversion.outputs < 200, `${st.lastConversion.outputs}`);
  st.execDelay = 0; st.frames = 30;
  check("cancel 後も続けて出力できる", types(await send({ type: "export", file: FILE, quality: "standard" })).includes("done"));

  // ---- 診断用: 画像検出 ----
  setValid(640, 480, 960);
  const bmp = { width: 640, height: 480, _data: null };
  const src2 = new OffscreenCanvas(640, 480); src2._ctx.__paint(); bmp._data = src2._data;
  ms = await send({ type: "detect-image", bitmap: bmp, id: 5 });
  check("detect-image: 検出1件・確定トラック・モザイク画素>1500を返す", ms[0].type === "detected" && ms[0].faces === 1 && ms[0].tracks === 1 && ms[0].changedPixels > 1500 && ms[0].boxes.length === 1, JSON.stringify(ms[0]).slice(0, 200));

  // ---- 例外の変換 ----
  st.initError = "unexpected failure in conversion setup"; const bad = await send({ type: "export", file: FILE, quality: "standard" }); st.initError = null;
  const be = bad.find((m) => m.type === "error");
  check("想定外の例外も error メッセージに変換され(Worker が落ちない)、busy も解除される", be && be.for === "export" && be.message.includes("unexpected failure") && types(await send({ type: "export", file: FILE, quality: "standard" })).includes("done"), JSON.stringify(bad));

  // ---- 長時間処理でのメモリ ----
  st.frames = 400; global.gc && global.gc(); const rss0 = process.memoryUsage().rss;
  await send({ type: "export", file: FILE, quality: "standard" }); st.frames = 400; await send({ type: "export", file: FILE, quality: "standard" });
  global.gc && global.gc(); const growth = (process.memoryUsage().rss - rss0) / 1048576;
  check(`800フレーム(2回の書き出し)後もメモリが増え続けない(増加${growth.toFixed(0)}MB)`, growth < 120, growth);

  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
