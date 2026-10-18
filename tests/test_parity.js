// Python 実装(engine.py)との一致検証。vectors.json は tests/gen_vectors.py で生成した「正解」。
// 実行: node tests/test_parity.js
const path = require("path"), fs = require("fs");
const FM = require("../js/core.js");
const V = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8"));
let fails = 0, passes = 0;
const check = (name, ok, detail) => { if (ok) passes++; else fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail ? "  [" + detail + "]" : "")); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const arrNear = (a, b, tol) => a.length === b.length && a.every((v, i) => near(v, b[i], tol));

(async () => {
  // ---- 丸め ----
  check("pyRound が Python の round() と一致(偶数丸め含む)", V.round.every((c) => FM.pyRound(c.x) === c.expected),
        JSON.stringify(V.round.filter((c) => FM.pyRound(c.x) !== c.expected)));

  // ---- dynamic-input の検出ロジック ----
  let bad = [], coarseMismatch = [], kept = 0, rows = 0, coarseRuns = 0;
  V.dynamic.forEach((c, i) => {
    let coarseCalled = false;
    const res = FM.detectDynamicLogic(c.W, c.H, c.maxDim,
      (dw, dh) => { if (dw !== c.dw || dh !== c.dh) bad.push(`#${i} 主検出サイズ ${dw}x${dh} != ${c.dw}x${c.dh}`); return { data: Float32Array.from(c.primary), rows: c.nPrimary }; },
      (cw, ch) => { coarseCalled = true; if (cw !== c.cw || ch !== c.ch) bad.push(`#${i} 粗スケールサイズ ${cw}x${ch} != ${c.cw}x${c.ch}`); return { data: Float32Array.from(c.coarse), rows: c.nCoarse }; });
    rows += c.nPrimary + c.nCoarse; kept += res.length; if (coarseCalled) coarseRuns++;
    if (coarseCalled !== c.coarseCalled) coarseMismatch.push(`#${i}: JS=${coarseCalled} PY=${c.coarseCalled}`);
    if (res.length !== c.expected.length) { bad.push(`#${i} 件数 JS=${res.length} PY=${c.expected.length}`); return; }
    res.forEach((r, k) => { if (!arrNear(r.box, c.expected[k].box, 1e-9) || !near(r.confidence, c.expected[k].confidence)) bad.push(`#${i}/${k} box/conf`); });
  });
  check(`dynamic検出ロジック: ${V.dynamic.length}ケース(入力行${rows}→採用${kept})が、件数・順序・座標・信頼度まで全て一致`, bad.length === 0, bad.slice(0, 5).join("; "));
  check(`粗スケール再検出を行うかの判断が全ケースで一致(実行${coarseRuns}/${V.dynamic.length})`, coarseMismatch.length === 0, coarseMismatch.slice(0, 5).join("; "));
  check("テストが有意: 採用/棄却の両方があり、粗スケールの有/無の両方がある", kept > 50 && kept < rows && coarseRuns > 20 && coarseRuns < V.dynamic.length - 5, `${kept}/${rows} coarse=${coarseRuns}`);

  // ---- 境界値（しきい値の直前・直後・ちょうど） ----
  const unspecial = (arr) => Float32Array.from(arr.map((v) => (v === "nan" ? NaN : v === "inf" ? Infinity : v === "-inf" ? -Infinity : v)));
  bad = []; let bAccepted = 0, bRejected = 0, bCoarseDiff = [];
  V.dynamic_boundary.forEach((c) => {
    let coarseCalled = false;
    const res = FM.detectDynamicLogic(c.W, c.H, c.maxDim,
      () => ({ data: unspecial(c.primary), rows: c.nPrimary }),
      () => { coarseCalled = true; return { data: unspecial(c.coarse), rows: c.nCoarse }; });
    if (coarseCalled !== c.coarseCalled) bCoarseDiff.push(c.label);
    res.length ? bAccepted++ : bRejected++;
    if (res.length !== c.expected.length) { bad.push(`${c.label}: 件数 JS=${res.length} PY=${c.expected.length}`); return; }
    res.forEach((r, k) => { if (!arrNear(r.box, c.expected[k].box, 1e-9) || !near(r.confidence, c.expected[k].confidence)) bad.push(`${c.label}: box/conf`); });
  });
  check(`境界値${V.dynamic_boundary.length}ケース(信頼度・サイズ・縦横比・端・中心・粗スケール・マージ・NaN等のしきい値の前後)が全て一致`, bad.length === 0, bad.slice(0, 4).join("; "));
  check("境界値: 粗スケール再検出の発動判断も一致", bCoarseDiff.length === 0, bCoarseDiff.slice(0, 4).join("; "));
  check(`境界値: 採用と棄却の両方を含む(採用${bAccepted}/棄却${bRejected})`, bAccepted > 15 && bRejected > 15);

  // ---- ハンガリアン法 ----
  bad = [];
  V.assign.forEach((c, i) => {
    const pairs = FM.linearSumAssignment(c.cost);
    const total = pairs.reduce((s, [r, k]) => s + c.cost[r][k], 0);
    const same = JSON.stringify(pairs) === JSON.stringify(c.pairs);
    if (!near(total, c.total, 1e-9) || !same) bad.push(`#${i} total ${total} vs ${c.total} same=${same}`);
  });
  check(`割り当て(scipy相当): ${V.assign.length}行列(1〜9×1〜9)で最適コスト・組合せが一致`, bad.length === 0, bad.slice(0, 3).join("; "));

  // ---- 追跡 ----
  for (const mode of ["hungarian", "greedy"]) {
    let nbad = [], frames = 0, ntr = 0;
    V.tracker.forEach((sc, si) => {
      let tracks = [], nid = 1;
      sc.seq.forEach((dets, f) => {
        const r = FM.updateTracksPool(tracks, dets.map((d) => ({ box: d.box.slice(), confidence: d.confidence })), nid, mode === "hungarian");
        tracks = r.tracks; nid = r.nextId; frames++;
        const exp = sc[mode][f];
        if (tracks.length !== exp.length) { nbad.push(`s${si}f${f} n=${tracks.length}!=${exp.length}`); return; }
        tracks.forEach((t, k) => {
          const e = exp[k]; ntr++;
          if (t.trackId !== e.id || t.hits !== e.hits || t.missingCount !== e.missing || t.confirmed !== e.confirmed ||
              !arrNear(t.box, e.box, 1e-9) || !arrNear(t.velocity, e.vel, 1e-9) || !arrNear(t.getRenderBox(), e.render, 1e-9))
            nbad.push(`s${si}f${f}t${k}`);
        });
      });
    });
    check(`追跡(${mode}): ${V.tracker.length}シナリオ/${frames}フレーム/トラック${ntr}件の全状態(ID・位置・速度・確定・欠損)が一致`, nbad.length === 0, nbad.slice(0, 5).join("; "));
  }

  // ---- ビットレート ----
  check("軽量モードのビットレート計算が一致", V.bitrate.every((c) => FM.calculateCompactBitrate(c.size, c.dur) === c.expected),
        JSON.stringify(V.bitrate.map((c) => [FM.calculateCompactBitrate(c.size, c.dur), c.expected])));

  // ---- モザイク（OpenCV.js でピクセル単位の一致） ----
  let cv = require("../vendor/opencv.js");
  if (cv instanceof Promise || typeof cv.then === "function") cv = await cv;
  let maxDiff = 0, diffPx = 0, totalPx = 0, changed = 0;
  for (const c of V.mosaic) {
    const bgr = Buffer.from(c.image, "base64"), exp = Buffer.from(c.expected, "base64");
    const rgba = new Uint8Array(c.W * c.H * 4);
    for (let p = 0; p < c.W * c.H; p++) { rgba[p * 4] = bgr[p * 3 + 2]; rgba[p * 4 + 1] = bgr[p * 3 + 1]; rgba[p * 4 + 2] = bgr[p * 3]; rgba[p * 4 + 3] = 255; }
    const mat = new cv.Mat(c.H, c.W, cv.CV_8UC4); mat.data.set(rgba);
    const tracks = c.tracks.map((t, k) => { const tr = new FM.RobustFaceTrack(t.box, k + 1, 0.9); tr.confirmed = t.confirmed; tr.hits = t.hits; tr.velocity = t.velocity.slice(); return tr; });
    FM.applyMosaic(cv, mat, tracks);
    const out = mat.data;
    for (let p = 0; p < c.W * c.H; p++) {
      totalPx++;
      const d = Math.max(Math.abs(out[p * 4 + 2] - exp[p * 3]), Math.abs(out[p * 4 + 1] - exp[p * 3 + 1]), Math.abs(out[p * 4] - exp[p * 3 + 2]));
      if (d) { diffPx++; maxDiff = Math.max(maxDiff, d); }
      if (exp[p * 3] !== bgr[p * 3] || exp[p * 3 + 1] !== bgr[p * 3 + 1] || exp[p * 3 + 2] !== bgr[p * 3 + 2]) changed++;
      if (out[p * 4 + 3] !== 255) { diffPx++; maxDiff = 255; }
    }
    mat.delete();
  }
  check(`モザイク: ${V.mosaic.length}画像/${totalPx}画素がPython(cv2)の出力とピクセル単位で一致(差異画素=${diffPx}, 最大差=${maxDiff})`, diffPx === 0, `diffPx=${diffPx} max=${maxDiff}`);
  check("モザイク: 実際に画素が変化している(テストが有意)", changed > 3000, changed);

  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
