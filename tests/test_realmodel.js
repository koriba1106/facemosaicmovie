// 本物のモデル(2026may)＋実OpenCV.js(WASM)で、Python(cv2)実装と同じ検出になることを検証する。
// 正解は tests/gen_real_fixtures.py が Python 実装で生成したもの。実行: node --expose-gc tests/test_realmodel.js
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
const FM = require("../js/core.js"), PL = require("../js/pipeline.js");
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };

(async () => {
  let cv = require("../vendor/opencv.js"); if (cv instanceof Promise || typeof cv.then === "function") cv = await cv;
  const model = fs.readFileSync(path.join(ROOT, "models", FM.C.MODEL_FILENAME));
  const ab = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength);
  check("同梱モデルのサイズとSHA-256が固定値と一致", model.length === FM.C.MODEL_SIZE && require("crypto").createHash("sha256").update(model).digest("hex") === FM.C.MODEL_SHA256);

  let t0 = Date.now(); const detector = PL.createDynamicDetector(cv, FM, ab);
  check(`実モデルで検出器を作成し、起動時の自己診断(形違い4回の推論)が通る (${Date.now() - t0}ms)`, !!detector.primary && !!detector.coarse);

  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/frames.json"), "utf8"));
  const blob = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/frames.bin.gz")));
  const pipe = new PL.FacePipeline(cv, FM, detector);
  const toRgba = (e) => { const bgr = blob.subarray(e.offset, e.offset + e.w * e.h * 3), a = new Uint8ClampedArray(e.w * e.h * 4);
    for (let i = 0; i < e.w * e.h; i++) { a[i * 4] = bgr[i * 3 + 2]; a[i * 4 + 1] = bgr[i * 3 + 1]; a[i * 4 + 2] = bgr[i * 3]; a[i * 4 + 3] = 255; } return a; };

  let maxPos = 0, maxConf = 0, cases = 0, totalFaces = 0, bad = [], times = [];
  for (const e of meta) {
    const rgba = toRgba(e);
    for (const md of [640, 480]) {
      const t = process.hrtime.bigint(); const dets = pipe.detectOnly(rgba, e.w, e.h, md); times.push(Number(process.hrtime.bigint() - t) / 1e6);
      const exp = e.results[String(md)]; cases++; totalFaces += exp.length;
      if (dets.length !== exp.length) { bad.push(`${e.name}@${md}: 件数 JS=${dets.length} PY=${exp.length}`); continue; }
      // 順序は信頼度順で同じはずだが、念のため最近傍で対応づける
      for (const d of dets) {
        let best = null, bd = 1e9; for (const x of exp) { const dd = Math.max(...d.box.map((v, i) => Math.abs(v - x.box[i]))); if (dd < bd) { bd = dd; best = x; } }
        maxPos = Math.max(maxPos, bd); maxConf = Math.max(maxConf, Math.abs(d.confidence - best.confidence));
      }
    }
  }
  check(`${cases}ケース(実画像11枚×検出解像度2種, 顔${totalFaces}件)で検出件数が Python 版と完全一致`, bad.length === 0, bad.join("; "));
  check(`検出位置の最大差 ${maxPos.toFixed(3)}px（許容 0.5px）, 信頼度の最大差 ${maxConf.toFixed(4)}（許容 0.005）`, maxPos <= 0.5 && maxConf <= 0.005, `${maxPos} ${maxConf}`);

  // --- 結合: 検出→追跡→モザイク（実モデル） ---
  const byName = Object.fromEntries(meta.map((e) => [e.name, e]));
  const run = (name, md = 640, frames = 3) => { const e = byName[name]; const p = new PL.FacePipeline(cv, FM, detector); let last, orig, r;
    for (let i = 0; i < frames; i++) { last = toRgba(e); orig = last.slice(); r = p.processFrame(last, e.w, e.h, md, true); }
    let changed = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1; for (let y = 0; y < e.h; y++) for (let x = 0; x < e.w; x++) { const i = (y * e.w + x) * 4; if (last[i] !== orig[i] || last[i + 1] !== orig[i + 1] || last[i + 2] !== orig[i + 2]) { changed++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
    p.dispose(); return { r, changed, bbox: [minX, minY, maxX, maxY] }; };
  // 顔は (210,70) に貼った220px画像内の約(58,53)-(148,166) → パディング込みで x259〜367, y109〜250
  let a = run("astro_normal");
  check(`実モデル: 顔1件を検出・確定し、モザイクが顔の位置に掛かる(変化${a.changed}画素, 範囲${JSON.stringify(a.bbox)})`, a.r.tracks === 1 && a.changed > 4000 && a.bbox[0] > 240 && a.bbox[2] < 380 && a.bbox[1] > 95 && a.bbox[3] < 260, JSON.stringify(a));
  for (const n of ["noface_coffee", "noface_cat", "noface_camera"]) { const q = run(n); check(`実モデル: 顔のない画像(${n})にモザイクを掛けない`, q.changed === 0 && q.r.tracks === 0, JSON.stringify(q)); }
  a = run("astro_two"); check("実モデル: 2人の顔にそれぞれトラックができる", a.r.tracks === 2, a.r.tracks);
  a = run("astro_edge"); check("実モデル: 画面端で切れた顔も検出して確定する", a.r.tracks === 1, a.r.tracks);
  a = run("astro_portrait"); check("実モデル: 縦長フレーム(360x640)で動作", a.r.tracks === 1, a.r.tracks);
  a = run("astro_tiny"); check("実モデル: 小さいフレーム(320x180)で動作", a.r.tracks === 1, a.r.tracks);
  a = run("astro_large"); check("実モデル: 大きい顔(粗スケール再検出の経路)で動作", a.r.tracks === 1, a.r.tracks);

  times.sort((x, y) => x - y);
  console.log(`   (参考) 検出1回の所要時間(前処理込み): 中央値 ${times[times.length >> 1].toFixed(0)}ms / 最大 ${times[times.length - 1].toFixed(0)}ms [このPCのNode上]`);

  // --- Mat の生存数（実モデル。検出器の生成時の自己診断と、実検出の両方） ---
  {
    const { cvT, live, restore } = require("./mat_tracker.js")(cv);
    try {
      const det2 = PL.createDynamicDetector(cvT, FM, ab);
      check(`検出器の生成(起動時の自己診断を含む)で作った一時 Mat が全て解放される(生存 ${live.size} 個)`, live.size === 0, live.size);
      const pl = new PL.FacePipeline(cvT, FM, det2); const e1 = byName["astro_two"], e2 = byName["noface_cat"];
      for (let i = 0; i < 6; i++) { pl.processFrame(toRgba(e1), e1.w, e1.h, 640, true); pl.processFrame(toRgba(e2), e2.w, e2.h, 640, true); }
      check(`実モデルで、顔あり/なし・解像度違いを交互に処理しても、生存する Mat は常駐の5個だけ(${live.size}個)`, live.size === 5, live.size);
      pl.dispose(); check("dispose 後は生存0個", live.size === 0, live.size);
      PL.disposeDetector(det2);
    } finally { restore(); }
  }

  // --- メモリ: 実モデルで 300 フレーム ---
  const e0 = byName["astro_normal"], px = toRgba(e0); global.gc && global.gc(); const rss0 = process.memoryUsage().rss; const p2 = new PL.FacePipeline(cv, FM, detector);
  for (let i = 0; i < 30; i++) p2.processFrame(px.slice(), e0.w, e0.h, 640, true);
  global.gc && global.gc(); const rssW = process.memoryUsage().rss;
  for (let i = 0; i < 300; i++) p2.processFrame(px.slice(), e0.w, e0.h, 640, true);
  global.gc && global.gc(); const growth = (process.memoryUsage().rss - rssW) / 1048576; p2.dispose();
  check(`実モデルで300フレーム処理後もメモリが増え続けない(ウォームアップ後の増加 ${growth.toFixed(0)}MB, 許容150MB)`, growth < 150, growth);

  // --- 改ざんされたモデルは読み込みで失敗する（実OpenCV.js） ---
  const broken = new Uint8Array(ab.slice(0)); for (let i = 5000; i < 5400; i++) broken[i] ^= 0xff;
  let msg = ""; try { PL.createDynamicDetector(cv, FM, broken.buffer); } catch (err) { msg = String(err.message || err); }
  check("壊れたモデルは例外(推論失敗/読み込み失敗)になり、プロセスは継続する", msg.length > 0, msg);
  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
})().catch((err) => { console.error("CRASH", err && err.stack || err); process.exit(2); });
