// パイプラインの結合検証（実 OpenCV.js / 検出器のみ偽物）。実行: node --expose-gc tests/test_pipeline.js
// ※ 本物のモデルでの検証は test_realmodel.js
const FM = require("../js/core.js");
const PL = require("../js/pipeline.js");
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };

(async () => {
  let cv = require("../vendor/opencv.js"); if (cv instanceof Promise || typeof cv.then === "function") cv = await cv;

  // 偽の YuNet: 「有効領域に対する比率」で与えた顔を、FaceDetectorYN と同じ形式(N×15, float32)で返す
  class FakeYuNet {
    constructor() { this.faces = []; this.valid = null; this.size = null; this.sizes = []; this.calls = 0; this.fail = false; }
    setInputSize(s) { this.size = [s.width, s.height]; this.sizes.push(this.size.join("x")); }
    detect(img, out) {
      this.calls++;
      if (this.fail) throw new Error("detector boom");
      if (!this.size || img.cols !== this.size[0] || img.rows !== this.size[1]) throw new Error(`入力サイズ不一致 ${img.cols}x${img.rows} vs ${this.size}`);
      if (img.cols % 32 || img.rows % 32) throw new Error(`32の倍数でない入力 ${img.cols}x${img.rows}`);
      if (img.channels() !== 3) throw new Error("BGR 3ch が必要");
      if (!this.faces.length) return 0;
      const [vw, vh] = this.valid, arr = [];
      for (const f of this.faces) {
        const x = f.fx * vw, y = f.fy * vh, w = f.fw * vw, h = f.fh * vw;      // 高さは幅基準（縦横比をほぼ1に）
        arr.push(x, y, w, h, x + w * .3, y + h * .38, x + w * .7, y + h * .38, x + w * .5, y + h * .58, x + w * .35, y + h * .78, x + w * .65, y + h * .78, f.conf);
      }
      const m = cv.matFromArray(this.faces.length, 15, cv.CV_32F, arr); m.copyTo(out); m.delete(); return 1;
    }
  }
  const mkDet = () => { const p = new FakeYuNet(), q = new FakeYuNet(); return { primary: { det: p, size: null }, coarse: { det: q, size: null }, p, q }; };
  const setValid = (d, w, h, md) => { const { dw, dh } = FM.detectionSize(w, h, md); d.p.valid = [dw, dh]; return [dw, dh]; };
  const mkFrame = (w, h, seed = 0) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { a[i * 4] = (i * 7 + seed) & 255; a[i * 4 + 1] = ((i / w) | 0) * 255 / h; a[i * 4 + 2] = (i % w) * 255 / w; a[i * 4 + 3] = 255; } return a; };
  const FACE = { fx: 0.40, fy: 0.28, fw: 0.14, fh: 0.15, conf: 0.9 };

  // ---- 基本動作: 1080p 入力 → 960 で検出（32の倍数に埋めて推論）→ 原画座標にモザイク ----
  const W = 1920, H = 1080, D = mkDet(); const pipe = new PL.FacePipeline(cv, FM, D);
  setValid(D, W, H, 960); D.p.faces = [FACE];
  let frame = mkFrame(W, H), orig = frame.slice();
  let r = pipe.processFrame(frame, W, H, FM.C.DYN_EXPORT_DETECT_DIM, true);
  check("1080pフレームで検出→確定トラック作成(高信頼は即確定)", r.faces === 1 && r.tracks === 1 && pipe.tracks[0].confirmed, JSON.stringify(r));
  check("推論の入力は 960x540 に縮小したうえで 32 の倍数(960x544)に埋めて渡す", D.p.sizes[0] === "960x544", D.p.sizes.join());
  const fx1 = FACE.fx * 960 * 2 - FACE.fw * 960 * 2 * 0.1, fx2 = (FACE.fx + FACE.fw) * 960 * 2 + FACE.fw * 960 * 2 * 0.1;
  let inFace = 0, outFace = 0, bad = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, ch = frame[i] !== orig[i] || frame[i + 1] !== orig[i + 1] || frame[i + 2] !== orig[i + 2];
    const inside = x >= fx1 - 3 && x < fx2 + 3 && y >= FACE.fy * 540 * 2 - 40 && y < (FACE.fy * 540 + FACE.fw * 960 * 0.9) * 2 + 40 + FACE.fh * 960 * 2 * 0.2;
    if (inside && ch) inFace++; if (!inside && ch) outFace++; if (frame[i + 3] !== 255) bad++;
  }
  check(`モザイクは顔領域のみ変化(領域内${inFace}画素/領域外${outFace}画素)`, inFace > 10000 && outFace === 0, `${inFace}/${outFace}`);
  check("アルファ値は全画素255のまま", bad === 0);

  // ---- 埋め込み領域(パディング)の誤検出は捨てる ----
  const Dp = mkDet(); const pp = new PL.FacePipeline(cv, FM, Dp); setValid(Dp, 640, 360, 960);
  Dp.p.faces = [{ fx: 1.01, fy: 0.3, fw: 0.1, fh: 0.1, conf: 0.99 }];        // 有効領域(640x360)の外=埋めた黒い領域に中心がある
  const fp = mkFrame(640, 360); const op = fp.slice(); const rp = pp.processFrame(fp, 640, 360, 960, true);
  check("パディング領域に出た検出は除外され、モザイクも掛からない", rp.faces === 0 && Buffer.compare(Buffer.from(fp), Buffer.from(op)) === 0, JSON.stringify(rp));

  // ---- 低信頼→2フレームで確定、欠損は8フレーム保持して消滅 ----
  const D2 = mkDet(); const p2 = new PL.FacePipeline(cv, FM, D2); setValid(D2, W, H, 960); D2.p.faces = [{ ...FACE, conf: 0.5 }];
  const f1 = mkFrame(W, H), o1 = f1.slice(); p2.processFrame(f1, W, H, 960, true);
  check("低信頼(0.5)の初回フレームは確定せずモザイクなし(誤検出の抑制)", !p2.tracks[0].confirmed && Buffer.compare(Buffer.from(f1), Buffer.from(o1)) === 0);
  p2.processFrame(mkFrame(W, H), W, H, 960, true);
  check("2フレーム目で確定", p2.tracks[0].confirmed);
  D2.p.faces = []; const alive = [];
  for (let i = 0; i < 10; i++) { p2.processFrame(mkFrame(W, H), W, H, 960, true); alive.push(p2.tracks.length); }
  check("検出が途切れても8フレーム保持し、9フレーム目で消滅", alive.slice(0, 8).every((n) => n === 1) && alive[8] === 0, alive.join());
  check("顔が見つからないフレームでは粗スケール再検出も試みる(両方の検出器が呼ばれる)", D2.q.calls > 0);
  const D3 = mkDet(); const p3 = new PL.FacePipeline(cv, FM, D3); setValid(D3, W, H, 960); D3.p.faces = [FACE];
  p3.processFrame(mkFrame(W, H), W, H, 960, true); D3.p.faces = [];
  const fi = mkFrame(W, H), oi = fi.slice(); p3.processFrame(fi, W, H, 960, true);
  check("検出が途切れた直後も予測位置にモザイクが掛かる", Buffer.compare(Buffer.from(fi), Buffer.from(oi)) !== 0);

  // ---- 助走フレーム(mosaic=false)と renderCurrent ----
  const D4 = mkDet(); const p4 = new PL.FacePipeline(cv, FM, D4); setValid(D4, W, H, 640); D4.p.faces = [FACE];
  const w1 = mkFrame(W, H, 1), w2 = mkFrame(W, H, 2), w2o = w2.slice();
  p4.processFrame(w1, W, H, 640, false); p4.processFrame(w2, W, H, 640, false);
  check("mosaic=false(プレビュー助走)は画素を変更せず追跡のみ更新", Buffer.compare(Buffer.from(w2), Buffer.from(w2o)) === 0 && p4.tracks.length === 1);
  const rendered = p4.renderCurrent();
  let rc = 0, ro = 0; for (let i = 0; i < W * H; i++) if (rendered[i * 4] !== w2o[i * 4] || rendered[i * 4 + 1] !== w2o[i * 4 + 1]) rc++;
  check(`renderCurrent: 最終フレームにだけモザイク(変化${rc}画素)・Uint8ClampedArrayのコピーを返す`, rc > 5000 && rendered instanceof Uint8ClampedArray && rendered.length === W * H * 4 && !ro);
  let rmsg = ""; try { new PL.FacePipeline(cv, FM, mkDet()).renderCurrent(); } catch (e) { rmsg = e.message; }
  check("フレーム未処理での renderCurrent は明確なエラー", rmsg.includes("処理済み"), rmsg);
  const dd = mkDet(); const p9 = new PL.FacePipeline(cv, FM, dd); setValid(dd, 640, 360, 640); dd.p.faces = [FACE];
  const det = p9.detectOnly(mkFrame(640, 360), 640, 360, 640);
  check("detectOnly: 追跡せず検出結果だけを返す", det.length === 1 && p9.tracks.length === 0 && det[0].box.length === 4, JSON.stringify(det));

  // ---- 解像度変更・小さい画像・奇数サイズ・32の倍数でないサイズ ----
  const D5 = mkDet(); const p5 = new PL.FacePipeline(cv, FM, D5);
  for (const [w, h] of [[640, 360], [320, 240], [1280, 720], [641, 481], [1080, 1920], [100, 60], [33, 31]]) {
    D5.p.faces = [{ fx: 0.3, fy: 0.3, fw: 0.3, fh: 0.3, conf: 0.9 }]; const [dw] = setValid(D5, w, h, 960);
    const fr = mkFrame(w, h); let ok = true, err = "";
    try { p5.resetTracking(); const rr = p5.processFrame(fr, w, h, 960, true); ok = rr.faces === 1 || dw * 0.3 < 16 * (dw / w); } catch (e) { ok = false; err = e.message; }
    check(`解像度 ${w}x${h} でも処理できる(再確保・縮小・32の倍数への埋め込み)`, ok, err);
  }

  // ---- メモリリーク検査 ----
  const W2 = 1280, H2 = 720, D6 = mkDet(); setValid(D6, W2, H2, 960); D6.p.faces = [FACE, { fx: 0.7, fy: 0.4, fw: 0.1, fh: 0.1, conf: 0.7 }];
  const p6 = new PL.FacePipeline(cv, FM, D6); const buf = mkFrame(W2, H2);
  for (let i = 0; i < 30; i++) p6.processFrame(buf, W2, H2, 960, true);
  global.gc && global.gc(); const rss0 = process.memoryUsage().rss; let t0 = Date.now();
  for (let i = 0; i < 600; i++) { D6.p.faces[0].fx = 0.40 + (i % 50) * 0.001; p6.processFrame(buf, W2, H2, 960, true); }
  global.gc && global.gc(); const growMB = (process.memoryUsage().rss - rss0) / 1048576, ms = (Date.now() - t0) / 600;
  check(`600フレーム処理後もメモリが増え続けない(増加${growMB.toFixed(0)}MB, 許容150MB; 前処理+モザイク ${ms.toFixed(1)}ms/フレーム)`, growMB < 150, growMB);
  p6.dispose(); p6.dispose(); check("dispose() は二重に呼んでも安全", true);

  // ---- Mat の生存数（JS から作られた Mat を全て記録し、解放漏れを1個単位で検出する） ----
  const { cvT, live, restore } = require("./mat_tracker.js")(cv);
  try {
    const DL = mkDet(); setValid(DL, 640, 360, 960); DL.p.faces = [FACE, { fx: 0.7, fy: 0.4, fw: 0.1, fh: 0.1, conf: 0.7 }];
    const pl = new PL.FacePipeline(cvT, FM, DL); const fb = mkFrame(640, 360);
    pl.processFrame(fb, 640, 360, 960, true);
    const base = live.size;
    for (let i = 0; i < 50; i++) pl.processFrame(fb, 640, 360, 960, true);
    check(`フレーム処理を繰り返しても、生存する Mat は一定(常駐 ${base} 個 → 50フレーム後 ${live.size} 個)`, live.size === base && base === 5, `${base}→${live.size}`);
    for (let i = 0; i < 5; i++) pl.processFrame(fb, 640, 360, 960, false);
    pl.renderCurrent();
    check("助走(mosaic=false)と renderCurrent の後も、Mat は増えない", live.size === base, live.size);
    DL.p.faces = []; for (let i = 0; i < 20; i++) pl.processFrame(fb, 640, 360, 960, true);
    check("顔が無いフレーム(粗スケール再検出の経路)を繰り返しても、Mat は増えない", live.size === base, live.size);
    for (const [w, h] of [[320, 240], [641, 481], [1280, 720]]) { DL.p.faces = [FACE]; setValid(DL, w, h, 960); pl.processFrame(mkFrame(w, h), w, h, 960, true); }
    check("解像度が変わっても、古い Mat は解放される(常駐は5個のまま)", live.size === 5, live.size);
    pl.dispose(); check("dispose() で、全ての Mat が解放される(生存0個)", live.size === 0, live.size);
    const Dx = mkDet(); Dx.p.fail = true; const px = new PL.FacePipeline(cvT, FM, Dx); const rx = px.processFrame(fb, 640, 360, 960, true);
    check("検出が例外を投げても、そのフレームで作った Mat は解放される(例外経路のリーク無し)", rx.detectError && live.size === 5, live.size); px.dispose();
    check("例外後に dispose すると生存0個", live.size === 0, live.size);
  } finally { restore(); }

  // ---- 異常系 ----
  const Df = mkDet(); Df.p.fail = true; const rf = new PL.FacePipeline(cv, FM, Df).processFrame(mkFrame(64, 64), 64, 64, 960, true);
  check("検出器の例外は握りつぶさず detectError として返す(上位でフレーム単位に数える)。追跡は『検出なし』として進む", rf.detectError && rf.detectError.message === "detector boom" && rf.faces === 0 && rf.tracks === 0, JSON.stringify(rf));
  let msg = "";
  let msg2 = ""; try { new PL.FacePipeline(cv, FM, mkDet()).processFrame(new Uint8ClampedArray(10), 64, 64, 960, true); } catch (e) { msg2 = e.message; }
  check("フレームサイズ不正は明確なエラー", msg2.includes("サイズ"), msg2);
  let emsg = ""; try { PL.createDynamicDetector(cv, FM, new Uint8Array(200000).buffer); } catch (e) { emsg = String(e.message || e); }
  check("不正なモデルデータは例外(読み込み失敗の案内)で、プロセスは継続", emsg.includes("YuNet") || emsg.includes("モデル"), emsg);
  check("OpenCV.js の FaceDetectorYN コンストラクタとファイルシステムAPIが公開されている", typeof cv.FaceDetectorYN === "function" && typeof cv.FS_createDataFile === "function" && typeof cv.copyMakeBorder === "function");

  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
