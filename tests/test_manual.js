// 手動モザイク（範囲指定）の検証。実 OpenCV.js・実モデル。実行: node --expose-gc tests/test_manual.js
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
const FM = require("../js/core.js"), PL = require("../js/pipeline.js");
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };
const throwsWith = (fn, needle) => { try { fn(); return false; } catch (e) { return !needle || e.message.includes(needle); } };
const R = (o = {}) => ({ x: 0.2, y: 0.3, w: 0.2, h: 0.25, start: 5, end: null, ...o });

(async () => {
  let cv = require("../vendor/opencv.js"); if (cv instanceof Promise || typeof cv.then === "function") cv = await cv;

  // ---------- 検証 ----------
  const ok = FM.sanitizeRegion(R());
  check("正しい範囲はそのまま受理(未使用の項目は引き継がない)", ok.x === 0.2 && ok.end === null && Object.keys(ok).join() === "x,y,w,h,start,end" && Object.keys(FM.sanitizeRegion({ ...R(), evil: 1, __proto__: { z: 1 } })).join() === "x,y,w,h,start,end");
  const cl = FM.sanitizeRegion(R({ x: -0.5, y: 0.9, w: 5, h: 5, start: -3 }));
  check("範囲外の値は 0〜1 に収め、画面からはみ出さない・開始は0以上", cl.x === 0 && cl.y === 0.9 && cl.w === 1 && Math.abs(cl.h - 0.1) < 1e-12 && cl.start === 0, JSON.stringify(cl));
  for (const [label, bad, needle] of [
    ["NaN の座標", R({ x: NaN }), "不正"], ["文字列の座標", R({ x: "0.2" }), "不正"], ["Infinity の幅", R({ w: Infinity }), "不正"], ["undefined の高さ", R({ h: undefined }), "不正"],
    ["開始が NaN", R({ start: NaN }), "不正"], ["終了が文字列", R({ end: "9" }), "終了"], ["終了が開始以前", R({ start: 5, end: 5 }), "開始より後"], ["終了が開始より前", R({ start: 5, end: 4 }), "開始より後"],
    ["幅が小さすぎる(0.5%)", R({ w: 0.005 }), "小さすぎ"], ["高さが0", R({ h: 0 }), "小さすぎ"], ["負の幅", R({ w: -0.3 }), "小さすぎ"], ["右端で幅がほぼ0になる", R({ x: 0.999, w: 0.5 }), "小さすぎ"],
    ["null", null, "不正"], ["数値", 5, "不正"], ["文字列", "x", "不正"],
  ]) check(`範囲の検証: ${label}は拒否`, throwsWith(() => FM.sanitizeRegion(bad), needle), JSON.stringify(bad));
  check("終了が null/undefined は『最後まで』として受理", FM.sanitizeRegion(R({ end: undefined })).end === null && FM.sanitizeRegion(R({ end: null })).end === null);
  check("終了が巨大でも上限(6時間)に収める", FM.sanitizeRegion(R({ start: 1, end: 1e12 })).end === FM.C.MAX_EXPORT_SECONDS);
  check("配列: 未指定は空、配列以外は拒否、上限(100件)", FM.sanitizeRegions(undefined).length === 0 && FM.sanitizeRegions(null).length === 0 && throwsWith(() => FM.sanitizeRegions({ length: 1 }), "不正") && FM.sanitizeRegions(Array.from({ length: 100 }, () => R())).length === 100 && throwsWith(() => FM.sanitizeRegions(Array.from({ length: 101 }, () => R())), "最大100件"));
  check("配列に1件でも不正があれば全体を拒否(部分的に通さない)", throwsWith(() => FM.sanitizeRegions([R(), R({ w: 0 }), R()]), "小さすぎ"));
  const req = FM.validateRequest({ type: "export", file: { size: 10, slice() {} }, quality: "standard", regions: [R({ end: 9 })] });
  check("Worker の入力検証: export/preview の regions を検証して正規化した値で受け取る", req.regions.length === 1 && req.regions[0].end === 9 && throwsWith(() => FM.validateRequest({ type: "preview", file: { size: 10, slice() {} }, time: 1, regions: [R({ x: NaN })] }), "不正") && FM.validateRequest({ type: "preview", file: { size: 10, slice() {} }, time: 1 }).regions.length === 0);

  // ---------- 時刻の判定 ----------
  const reg = [FM.sanitizeRegion(R({ start: 10, end: 13 })), FM.sanitizeRegion(R({ start: 20, end: null }))];
  const act = (t) => FM.activeRegions(reg, t).length;
  check("時刻の判定: 開始の瞬間は含み、直前は含まない / 終了の瞬間は含まない", act(9.99) === 0 && act(10) === 1 && act(12.999) === 1 && act(13) === 0 && act(13.001) === 0);
  check("時刻の判定: 終了なし(最後まで)は開始以降ずっと有効", act(19.99) === 0 && act(20) === 1 && act(1e6) === 1);
  check("時刻の判定: 誤差(±0.0005秒)は吸収する(開始のわずか手前のフレームも有効)", act(10 - 0.0003) === 1 && act(10 - 0.001) === 0);
  const fps = 30, start = 100 / fps; const r3 = FM.sanitizeRegion(R({ start, end: start + 3 }));
  let n = 0, first = -1, last = -1; for (let i = 0; i < 400; i++) if (FM.activeRegions([r3], i / fps).length) { n++; if (first < 0) first = i; last = i; }
  check(`30fps で『3秒間』は、ちょうど90フレーム(開始フレーム ${first} 〜 ${last})`, n === 90 && first === 100 && last === 189, `${n} ${first} ${last}`);
  const st23 = 100 * 1001 / 30000; const r23 = FM.sanitizeRegion(R({ start: st23, end: st23 + 2 })); let n2 = 0; for (let i = 0; i < 400; i++) if (FM.activeRegions([r23], i * 1001 / 30000).length) n2++;
  check("29.97fps(NTSC)でも『2秒間』はほぼ60フレーム(±1)", Math.abs(n2 - 60) <= 1, n2);
  check("範囲が複数あっても、時刻ごとに有効なものだけ選ぶ(順序を保つ)", FM.activeRegions([R({ start: 0, end: 5, x: 0.1 }), R({ start: 3, end: 8, x: 0.5 }), R({ start: 9, end: null, x: 0.9 })].map(FM.sanitizeRegion), 4).map((r) => r.x).join() === "0.1,0.5");

  // ---------- 座標 ----------
  check("画素座標への変換(割合 × 幅/高さ)", FM.regionToRect({ x: 0.2, y: 0.3, w: 0.2, h: 0.25 }, 1000, 400).every((v, i) => Math.abs(v - [200, 120, 400, 220][i]) < 1e-9));

  // ---------- モザイク（実OpenCV.js） ----------
  const W = 640, H = 360, mkRgba = (seed = 0) => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { a[i * 4] = (i * 7 + seed) & 255; a[i * 4 + 1] = ((i / W) | 0) * 255 / H; a[i * 4 + 2] = (i % W) * 255 / W; a[i * 4 + 3] = 255; } return a; };
  const toMat = (a) => { const m = new cv.Mat(H, W, cv.CV_8UC4); m.data.set(a); return m; };
  const diffBox = (a, b) => { let n = 0, x1 = 1e9, y1 = 1e9, x2 = -1, y2 = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { n++; x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); } } return { n, box: [x1, y1, x2 + 1, y2 + 1] }; };
  const base = mkRgba();
  {
    const rect = FM.regionToRect(FM.sanitizeRegion(R({ x: 0.25, y: 0.2, w: 0.3, h: 0.4 })), W, H);          // 160,72 〜 352,216
    const m = toMat(base); FM.applyManualRects(cv, m, [rect]); const out = new Uint8ClampedArray(m.data); m.delete();
    const d = diffBox(base, out);
    check(`手動範囲だけが変化し、範囲外は1画素も変わらない(変化範囲 ${JSON.stringify(d.box)} = 指定した [160,72,352,216] に一致)`, d.box.join() === "160,72,352,216" && d.n > 8000, JSON.stringify(d));
    // 顔モザイク(パリティ検証済みの関数)と、同じ範囲で全く同じ結果になるか
    const m2 = toMat(base); const tr = new FM.RobustFaceTrack(rect, 1, 0.9); FM.applyMosaic(cv, m2, [tr]); const viaFace = new Uint8ClampedArray(m2.data); m2.delete();
    check("手動範囲のモザイクは、同じ範囲の顔モザイク(Pythonとピクセル一致を確認済みの処理)と完全に同一", Buffer.compare(Buffer.from(out), Buffer.from(viaFace)) === 0);
    const small = FM.regionToRect(FM.sanitizeRegion(R({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 })), W, H); const m3 = toMat(base); FM.applyManualRects(cv, m3, [small]); const o3 = new Uint8ClampedArray(m3.data); m3.delete();
    check("小さい範囲(約64×36px)でも、変化は範囲内に収まる", (() => { const d3 = diffBox(base, o3); return d3.n > 100 && d3.box[0] >= 63.9 && d3.box[2] <= 128.1 && d3.box[1] >= 35.9 && d3.box[3] <= 72.1; })());
    const full = FM.regionToRect(FM.sanitizeRegion({ x: 0, y: 0, w: 1, h: 1, start: 0, end: null }), W, H); const m4 = toMat(base); FM.applyManualRects(cv, m4, [full]); const d4 = diffBox(base, new Uint8ClampedArray(m4.data)); m4.delete();
    check("画面全体を指定してもエラーにならず、画面全体に掛かる", d4.n > W * H * 0.9 && d4.box[0] === 0 && d4.box[2] === W);
    const m5 = toMat(base); FM.applyManualRects(cv, m5, []); FM.applyManualRects(cv, m5, null); check("範囲が空・null でも何もしない", Buffer.compare(Buffer.from(m5.data), Buffer.from(base)) === 0); m5.delete();
    const m6 = toMat(base); FM.applyManualRects(cv, m6, [FM.regionToRect(FM.sanitizeRegion(R({ x: 0.1, y: 0.1, w: 0.2, h: 0.3 })), W, H), FM.regionToRect(FM.sanitizeRegion(R({ x: 0.6, y: 0.5, w: 0.3, h: 0.3 })), W, H)]); const o6 = new Uint8ClampedArray(m6.data); m6.delete();
    const left = diffBox(base.slice(), o6);
    check("複数の範囲を同時に掛けられる(2か所が変化)", left.n > 10000 && left.box[0] < 100 && left.box[2] > 500);
  }

  // ---------- パイプライン統合（偽の検出器） ----------
  class FakeYuNet { constructor() { this.faces = []; this.valid = [640, 360]; this.size = null; this.fail = false; }
    setInputSize(s) { this.size = [s.width, s.height]; }
    detect(img, out) { if (this.fail) throw new Error("detector boom"); if (!this.faces.length) return 0; const [vw] = this.valid, arr = [];
      for (const f of this.faces) { const x = f.fx * vw, y = f.fy * this.valid[1], w = f.fw * vw, h = f.fw * vw; arr.push(x, y, w, h, x + w * .3, y + h * .38, x + w * .7, y + h * .38, x + w * .5, y + h * .58, x + w * .35, y + h * .78, x + w * .65, y + h * .78, 0.92); }
      const m = cv.matFromArray(this.faces.length, 15, cv.CV_32F, arr); m.copyTo(out); m.delete(); return 1; } }
  const mkDet = () => { const p = new FakeYuNet(), q = new FakeYuNet(); return { primary: { det: p, size: null }, coarse: { det: q, size: null }, p, q }; };
  const rectBox = [40, 40, 200, 140];

  let D = mkDet(), pl = new PL.FacePipeline(cv, FM, D), fr = mkRgba(), o = fr.slice();
  let r = pl.processFrame(fr, W, H, 960, true, [rectBox]);
  let d = diffBox(o, fr);
  check("顔が検出されない動画でも、手動範囲にはモザイクが掛かる(検出0件・変化は範囲内)", r.faces === 0 && d.n > 5000 && d.box[0] >= 39.9 && d.box[2] <= 200.1 && d.box[1] >= 39.9 && d.box[3] <= 140.1, JSON.stringify([r, d]));
  fr = mkRgba(); o = fr.slice(); pl.processFrame(fr, W, H, 960, true, []); check("範囲を渡さなければ、手動モザイクは掛からない", Buffer.compare(Buffer.from(fr), Buffer.from(o)) === 0);

  D = mkDet(); pl = new PL.FacePipeline(cv, FM, D); D.p.faces = [{ fx: 0.55, fy: 0.3, fw: 0.14 }];
  fr = mkRgba(); o = fr.slice(); r = pl.processFrame(fr, W, H, 960, true, [rectBox]); d = diffBox(o, fr);
  check("顔モザイクと手動モザイクを同時に掛けられる(顔1件+手動1か所で、画面の左右が両方変化)", r.tracks === 1 && d.box[0] < 120 && d.box[2] > 400, JSON.stringify([r, d]));

  // 検出エラー時: 追跡の予測でモザイクを継続し、手動範囲も掛かる（顔が漏れない）
  D = mkDet(); pl = new PL.FacePipeline(cv, FM, D); D.p.faces = [{ fx: 0.55, fy: 0.3, fw: 0.14 }];
  pl.processFrame(mkRgba(), W, H, 960, true, []); pl.processFrame(mkRgba(), W, H, 960, true, []);
  D.p.fail = true; D.q.fail = true; fr = mkRgba(); o = fr.slice(); r = pl.processFrame(fr, W, H, 960, true, [rectBox]); d = diffBox(o, fr);
  check("検出がエラーになっても例外にせず、detectError として返す", r.detectError && r.detectError.message === "detector boom" && r.faces === 0);
  check("★検出エラーのフレームでも、確定済みの顔は予測位置にモザイクが掛かり、手動範囲も掛かる(顔が漏れない)", r.tracks === 1 && d.box[0] < 120 && d.box[2] > 400, JSON.stringify([r, d]));
  const seq = []; for (let i = 0; i < 9; i++) { fr = mkRgba(); o = fr.slice(); pl.processFrame(fr, W, H, 960, true, []); seq.push(diffBox(o, fr).n > 0); }
  check("検出が連続して失敗しても、追跡の保持期間(8フレーム)はモザイクを継続し、その後は止まる", seq.slice(0, 7).every(Boolean) && seq[8] === false, seq.join());

  // プレビュー経路
  D = mkDet(); pl = new PL.FacePipeline(cv, FM, D); D.p.faces = [{ fx: 0.55, fy: 0.3, fw: 0.14 }];
  const a = mkRgba(1), b = mkRgba(2), bo = b.slice(); pl.processFrame(a, W, H, 640, false, [rectBox]); pl.processFrame(b, W, H, 640, false, [rectBox]);
  check("助走フレーム(mosaic=false)では、手動範囲も画素に掛けない", Buffer.compare(Buffer.from(b), Buffer.from(bo)) === 0);
  const rendered = pl.renderCurrent([rectBox]); d = diffBox(bo, rendered);
  check("renderCurrent(範囲つき)は、顔と手動範囲の両方にモザイクを掛けた画素を返す", d.box[0] < 120 && d.box[2] > 400 && rendered.length === W * H * 4);
  check("renderCurrent は内部の画像を書き換えない: 範囲なしで呼べば手動モザイクは掛からず、何度呼んでも同じ結果", diffBox(bo, pl.renderCurrent()).box[0] > 200 && Buffer.compare(Buffer.from(pl.renderCurrent()), Buffer.from(pl.renderCurrent())) === 0 && Buffer.compare(Buffer.from(pl.renderCurrent([rectBox])), Buffer.from(rendered)) === 0);

  // Mat の生存数
  { const { cvT, live, restore } = require("./mat_tracker.js")(cv);
    try { const Dl = mkDet(); Dl.p.faces = [{ fx: 0.55, fy: 0.3, fw: 0.14 }]; const p9 = new PL.FacePipeline(cvT, FM, Dl); const f9 = mkRgba();
      p9.processFrame(f9, W, H, 960, true, [rectBox, [300, 200, 400, 300]]); const base5 = live.size;
      for (let i = 0; i < 40; i++) p9.processFrame(f9, W, H, 960, true, [rectBox, [300, 200, 400, 300], [10, 10, 80, 60]]);
      check(`手動範囲を使っても Mat は増えない(常駐 ${base5} 個 → 40フレーム後 ${live.size} 個)`, live.size === base5 && base5 === 5, `${base5}→${live.size}`);
      Dl.p.fail = true; p9.processFrame(f9, W, H, 960, true, [rectBox]); check("検出エラーのフレームでも Mat は増えない", live.size === base5, live.size); p9.dispose(); check("dispose 後は0個", live.size === 0);
    } finally { restore(); } }

  // ---------- 実モデル ----------
  const model = fs.readFileSync(path.join(ROOT, "models", FM.C.MODEL_FILENAME));
  const det = PL.createDynamicDetector(cv, FM, model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength));
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/frames.json"), "utf8")), blob = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/frames.bin.gz")));
  const byName = Object.fromEntries(meta.map((e) => [e.name, e]));
  const rgbaOf = (e) => { const bgr = blob.subarray(e.offset, e.offset + e.w * e.h * 3), x = new Uint8ClampedArray(e.w * e.h * 4); for (let i = 0; i < e.w * e.h; i++) { x[i * 4] = bgr[i * 3 + 2]; x[i * 4 + 1] = bgr[i * 3 + 1]; x[i * 4 + 2] = bgr[i * 3]; x[i * 4 + 3] = 255; } return x; };
  const diffE = (e, p, q) => { let n = 0, x1 = 1e9, x2 = -1, y1 = 1e9, y2 = -1; for (let y = 0; y < e.h; y++) for (let x = 0; x < e.w; x++) { const i = (y * e.w + x) * 4; if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) { n++; x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); } } return { n, box: [x1, y1, x2 + 1, y2 + 1] }; };
  {
    const e = byName["noface_cat"], px = rgbaOf(e), orig = px.slice(), p = new PL.FacePipeline(cv, FM, det);
    const rc = FM.regionToRect(FM.sanitizeRegion({ x: 0.3, y: 0.3, w: 0.4, h: 0.4, start: 0, end: null }), e.w, e.h);
    for (let i = 0; i < 3; i++) { const f = orig.slice(); p.processFrame(f, e.w, e.h, 960, true, [rc]); if (i === 2) { const dd = diffE(e, orig, f); check(`実モデル: 顔のない画像でも、手動範囲だけにモザイクが掛かる(変化範囲 ${JSON.stringify(dd.box)})`, dd.n > 500 && dd.box[0] >= rc[0] - 1 && dd.box[2] <= rc[2] + 1 && dd.box[1] >= rc[1] - 1 && dd.box[3] <= rc[3] + 1, JSON.stringify(dd)); } }
    p.dispose();
    const e2 = byName["astro_two"], p2 = new PL.FacePipeline(cv, FM, det), rc2 = [10, 10, 70, 70], o2 = rgbaOf(e2); let last, res;
    for (let i = 0; i < 3; i++) { last = o2.slice(); res = p2.processFrame(last, e2.w, e2.h, 960, true, [rc2]); }
    const dd2 = diffE(e2, o2, last);
    check("実モデル: 顔2件の自動モザイクと、隅の手動範囲が同時に掛かる", res.tracks === 2 && dd2.box[0] < 20 && dd2.box[2] > 300, JSON.stringify([res.tracks, dd2]));
    p2.dispose();
  }
  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e && e.stack || e); process.exit(2); });
