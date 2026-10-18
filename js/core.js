/* FaceMosaic Browser - core.js
 * デスクトップ版/サーバー版 (engine.py) のアルゴリズムの JavaScript 移植。
 * ブラウザ API に依存しない純粋なロジックのみ（OpenCV.js は引数 cv として受け取る）。
 * Node.js でも読み込め、Python 実装との一致を tests/ で検証している。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FMCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ===== 定数（engine.py と同一。★はブラウザ版で追加） =====
  const C = {
    FACE_SCORE_THRESHOLD: 0.45,
    FACE_INSTANT_CONFIRM_SCORE: 0.65,
    FACE_NMS_THRESHOLD: 0.30,
    FACE_TOP_K: 1000,
    FACE_PADDING_X: 0.10,
    FACE_PADDING_Y: 0.12,
    TRACK_MAX_MISSING_CONFIRMED: 8,
    TRACK_MAX_MISSING_UNCONFIRMED: 0,
    TRACK_MIN_MATCH_SCORE: 0.35,
    TRACK_CONFIRM_FRAMES: 2,
    LANDMARK_MIN_VERTICAL_SPAN_RATIO: 0.04,
    LANDMARK_MIN_EYE_DIST_RATIO: 0.12,
    LANDMARK_MAX_EYE_DIST_RATIO: 1.05,
    LANDMARK_NOSE_MARGIN_RATIO: 0.35,
    LANDMARK_NOSE_VERTICAL_MARGIN_RATIO: 0.08,
    LANDMARK_MIN_MOUTH_DIST_RATIO: 0.05,
    LANDMARK_MAX_MOUTH_DIST_RATIO: 1.10,
    VELOCITY_DAMPING: 0.82,
    PREDICT_VELOCITY_FACTOR: 0.85,
    MAX_PREDICT_SHIFT_FACTOR: 0.80,
    LARGE_FACE_MOSAIC_SCALE: 0.06,
    SMALL_FACE_MOSAIC_SCALE: 0.10,
    HUNGARIAN_MAX_MATRIX_SIZE: 4096,
    COMPACT_TARGET_RATIO: 0.40,
    CONTAINER_RESERVE_RATIO: 0.018,
    COMPACT_AUDIO_BITRATE: 64000,
    PREVIEW_WARMUP_FRAMES: 12,

    // --- dynamic-input YuNet（2026may）---
    DYN_INPUT_ALIGN: 32,
    DYN_EXPORT_DETECT_DIM: 960,
    DYN_PREVIEW_DETECT_DIM: 640,
    DYN_COARSE_DETECT_DIM: 320,
    DYN_COARSE_LARGE_FACE_TRIGGER: 200.0,
    DYN_COARSE_MIN_CONF: 0.60,
    DYN_SMALL_FACE_PX: 28.0,
    DYN_SMALL_FACE_MIN_CONF: 0.55,
    DYN_EDGE_MIN_CONF: 0.60,
    DYN_EDGE_MARGIN_PX: 2.0,
    DYN_MERGE_IOU: 0.35,
    DYN_MERGE_CONTAINMENT: 0.70,
    // ★ 検出精度「高速」: 検出解像度を下げて約2倍速くする（小さい顔は見逃しやすくなる）
    FAST_EXPORT_DETECT_DIM: 640,
    FAST_PREVIEW_DETECT_DIM: 480,

    // ★ 使用するモデル（改ざん・差し替え対策としてハッシュを固定）
    MODEL_FILENAME: "face_detection_yunet_2026may.onnx",
    MODEL_SIZE: 229738,
    MODEL_SHA256: "ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0",

    // ★ 入力の上限（端末のメモリ枯渇の防止）
    MAX_PIXELS: 3840 * 2400,          // 4K UHD 相当
    MAX_FILE_BYTES: 4 * 1024 ** 3,
    WARN_FILE_BYTES: 1024 ** 3,
    MAX_EXPORT_SECONDS: 6 * 3600,
  };

  // ===== 数値ユーティリティ =====
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  /** Python の round()（偶数丸め）と同じ結果にする。モザイクの縮小サイズを一致させるため */
  function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  const alignUp = (v, unit) => Math.ceil(v / unit) * unit;

  // ===== 幾何 =====
  const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const boxCenter = (b) => [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5];
  const boxSize = (b) => [Math.max(1, b[2] - b[0]), Math.max(1, b[3] - b[1])];

  function iou(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (inter <= 0) return 0;
    const denom = boxArea(a) + boxArea(b) - inter;
    return denom > 0 ? inter / denom : 0;
  }

  function normalizedCenterDistance(a, b) {
    const [ax, ay] = boxCenter(a), [bx, by] = boxCenter(b);
    const dist = Math.hypot(ax - bx, ay - by);
    const [aw, ah] = boxSize(a), [bw, bh] = boxSize(b);
    const ref = Math.max(1, (Math.max(aw, ah) + Math.max(bw, bh)) * 0.5);
    return dist / ref;
  }

  function sizeSimilarity(a, b) {
    const [aw, ah] = boxSize(a), [bw, bh] = boxSize(b);
    return (Math.min(aw, bw) / Math.max(aw, bw) + Math.min(ah, bh) / Math.max(ah, bh)) * 0.5;
  }

  function clipBox(b, w, h) {
    const x1 = clamp(+b[0], 0, w), y1 = clamp(+b[1], 0, h);
    const x2 = clamp(+b[2], 0, w), y2 = clamp(+b[3], 0, h);
    if (x2 <= x1 || y2 <= y1) return null;
    return [x1, y1, x2, y2];
  }

  // ===== トラッカー =====
  class RobustFaceTrack {
    constructor(box, trackId, detectionConfidence = 1.0) {
      this.trackId = trackId | 0;
      this.box = box.map(Number);
      this.velocity = [0, 0];
      this.missingCount = 0;
      this.hits = 1;
      this.age = 1;
      this.lastDetectionConfidence = +detectionConfidence;
      this.confirmed = this.lastDetectionConfidence >= C.FACE_INSTANT_CONFIRM_SCORE;
      this.maxMissing = this.confirmed ? C.TRACK_MAX_MISSING_CONFIRMED : C.TRACK_MAX_MISSING_UNCONFIRMED;
    }

    predictedBox() {
      const vx = this.velocity[0] * C.PREDICT_VELOCITY_FACTOR;
      const vy = this.velocity[1] * C.PREDICT_VELOCITY_FACTOR;
      const b = this.box;
      return [b[0] + vx, b[1] + vy, b[2] + vx, b[3] + vy];
    }

    update(detectedBox, detectionConfidence = 1.0) {
      const [oldCx, oldCy] = boxCenter(this.box);
      const [newCx, newCy] = boxCenter(detectedBox);
      const [bw, bh] = boxSize(detectedBox);
      const maxVx = bw * C.MAX_PREDICT_SHIFT_FACTOR, maxVy = bh * C.MAX_PREDICT_SHIFT_FACTOR;
      const ivx = clamp(newCx - oldCx, -maxVx, maxVx);
      const ivy = clamp(newCy - oldCy, -maxVy, maxVy);
      this.velocity[0] = this.velocity[0] * 0.30 + ivx * 0.70;
      this.velocity[1] = this.velocity[1] * 0.30 + ivy * 0.70;
      this.box = detectedBox.map(Number);
      this.missingCount = 0;
      this.hits += 1;
      this.age += 1;
      this.lastDetectionConfidence = +detectionConfidence;
      if (this.hits >= C.TRACK_CONFIRM_FRAMES || this.lastDetectionConfidence >= C.FACE_INSTANT_CONFIRM_SCORE) {
        this.confirmed = true;
        this.maxMissing = C.TRACK_MAX_MISSING_CONFIRMED;
      }
    }

    predict() {
      this.missingCount += 1;
      this.age += 1;
      let vx = this.velocity[0] * C.PREDICT_VELOCITY_FACTOR;
      let vy = this.velocity[1] * C.PREDICT_VELOCITY_FACTOR;
      const [bw, bh] = boxSize(this.box);
      vx = clamp(vx, -bw * C.MAX_PREDICT_SHIFT_FACTOR, bw * C.MAX_PREDICT_SHIFT_FACTOR);
      vy = clamp(vy, -bh * C.MAX_PREDICT_SHIFT_FACTOR, bh * C.MAX_PREDICT_SHIFT_FACTOR);
      this.box[0] += vx; this.box[2] += vx;
      this.box[1] += vy; this.box[3] += vy;
      this.velocity[0] *= C.VELOCITY_DAMPING;
      this.velocity[1] *= C.VELOCITY_DAMPING;
    }

    getRenderBox() {
      const [x1, y1, x2, y2] = this.box;
      if (!this.confirmed || this.hits < 4) return [x1, y1, x2, y2];
      const [vx, vy] = this.velocity;
      const bw = x2 - x1, bh = y2 - y1;
      const leadX = clamp(vx * 0.12, -bw * 0.08, bw * 0.08);
      const leadY = clamp(vy * 0.12, -bh * 0.08, bh * 0.08);
      return [x1 + Math.min(0, leadX), y1 + Math.min(0, leadY), x2 + Math.max(0, leadX), y2 + Math.max(0, leadY)];
    }

    isLost() { return this.missingCount > this.maxMissing; }

    matchScore(detectedBox) {
      const predicted = this.predictedBox();
      const i = iou(predicted, detectedBox);
      const dist = normalizedCenterDistance(predicted, detectedBox);
      const sim = sizeSimilarity(predicted, detectedBox);
      if (dist > 2.5 && i < 0.05) return 0;
      return i * 0.50 + Math.exp(-1.15 * dist) * 0.32 + sim * 0.18;
    }
  }

  // ===== 割り当て =====
  /**
   * 矩形コスト行列の最小コスト割り当て（scipy.optimize.linear_sum_assignment 相当）。
   * cost: number[n][m]。min(n,m) 個の [row, col] を行番号順に返す。
   */
  function linearSumAssignment(cost) {
    const n0 = cost.length;
    const m0 = n0 ? cost[0].length : 0;
    if (!n0 || !m0) return [];
    const transposed = n0 > m0;
    const n = transposed ? m0 : n0, m = transposed ? n0 : m0;
    const a = (i, j) => (transposed ? cost[j - 1][i - 1] : cost[i - 1][j - 1]);   // 1 始まり

    const INF = Infinity;
    const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Float64Array(m + 1).fill(INF);
      const used = new Uint8Array(m + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0];
        let delta = INF, j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = a(i0, j) - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
          else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const pairs = [];
    for (let j = 1; j <= m; j++) {
      if (p[j]) pairs.push(transposed ? [j - 1, p[j] - 1] : [p[j] - 1, j - 1]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
    return pairs;
  }

  function matchTracksGreedy(tracks, detections) {
    const cands = [];
    tracks.forEach((t, ti) => detections.forEach((d, di) => {
      const s = t.matchScore(d.box);
      if (s >= C.TRACK_MIN_MATCH_SCORE) cands.push([s, ti, di]);
    }));
    cands.sort((a, b) => b[0] - a[0]);          // 安定ソート（Python の sort と同じ）
    const usedT = new Set(), usedD = new Set(), matches = [];
    for (const [, ti, di] of cands) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di); matches.push([ti, di]);
    }
    return matches;
  }

  function matchTracksHungarian(tracks, detections) {
    const matrix = tracks.map((t) => detections.map((d) => t.matchScore(d.box)));
    const cost = matrix.map((row) => row.map((s) => 1.0 - s));
    return linearSumAssignment(cost)
      .filter(([ti, di]) => matrix[ti][di] >= C.TRACK_MIN_MATCH_SCORE);
  }

  function matchTracksToDetections(tracks, detections, useHungarian = true) {
    if (!tracks.length || !detections.length) return [];
    if (useHungarian && tracks.length * detections.length <= C.HUNGARIAN_MAX_MATRIX_SIZE) {
      try { return matchTracksHungarian(tracks, detections); } catch (e) { /* greedy へ */ }
    }
    return matchTracksGreedy(tracks, detections);
  }

  /** @returns {{tracks: RobustFaceTrack[], nextId: number}} */
  function updateTracksPool(activeTracks, detections, nextTrackId, useHungarian = true) {
    if (!activeTracks.length && !detections.length) return { tracks: [], nextId: nextTrackId };
    const matches = matchTracksToDetections(activeTracks, detections, useHungarian);
    const mt = new Set(matches.map((m) => m[0])), md = new Set(matches.map((m) => m[1]));
    for (const [ti, di] of matches) activeTracks[ti].update(detections[di].box, detections[di].confidence);
    activeTracks.forEach((t, ti) => { if (!mt.has(ti)) t.predict(); });
    detections.forEach((d, di) => {
      if (!md.has(di)) activeTracks.push(new RobustFaceTrack(d.box, nextTrackId++, d.confidence));
    });
    return { tracks: activeTracks.filter((t) => !t.isLost()), nextId: nextTrackId };
  }

  // ===== YuNet 出力の後処理（dynamic-input 版） =====
  function validateFaceLandmarks(bw, bh, lm) {
    if (bw <= 0 || bh <= 0) return true;
    if (!lm.every(Number.isFinite)) return true;
    const [erX, erY, elX, elY, noseX, noseY, mrX, mrY, mlX, mlY] = lm;
    const eyeAvgY = (erY + elY) * 0.5, mouthAvgY = (mrY + mlY) * 0.5;
    if (mouthAvgY - eyeAvgY < bh * C.LANDMARK_MIN_VERTICAL_SPAN_RATIO) return false;
    const eyeDist = Math.abs(elX - erX);
    if (eyeDist < bw * C.LANDMARK_MIN_EYE_DIST_RATIO || eyeDist > bw * C.LANDMARK_MAX_EYE_DIST_RATIO) return false;
    const margin = eyeDist * C.LANDMARK_NOSE_MARGIN_RATIO;
    if (!(Math.min(erX, elX) - margin <= noseX && noseX <= Math.max(erX, elX) + margin)) return false;
    const vMargin = bh * C.LANDMARK_NOSE_VERTICAL_MARGIN_RATIO;
    if (!(eyeAvgY - vMargin <= noseY && noseY <= mouthAvgY + vMargin)) return false;
    const mouthDist = Math.abs(mlX - mrX);
    if (mouthDist < bw * C.LANDMARK_MIN_MOUTH_DIST_RATIO || mouthDist > bw * C.LANDMARK_MAX_MOUTH_DIST_RATIO) return false;
    return true;
  }

  /** 検出に使う縮小サイズ（元画像が maxDim 以下なら縮小しない） */
  function detectionSize(origW, origH, maxDim) {
    const scale = Math.min(1.0, maxDim / Math.max(origW, origH));
    if (scale < 1.0) {
      return { dw: Math.max(1, pyRound(origW * scale)), dh: Math.max(1, pyRound(origH * scale)), resized: true };
    }
    return { dw: origW, dh: origH, resized: false };
  }

  /** 検出精度('high'|'fast')と用途から、検出に使う最大辺を決める */
  function detectDim(accuracy, preview) {
    if (accuracy === "fast") return preview ? C.FAST_PREVIEW_DETECT_DIM : C.FAST_EXPORT_DETECT_DIM;
    return preview ? C.DYN_PREVIEW_DETECT_DIM : C.DYN_EXPORT_DETECT_DIM;
  }

  /**
   * モデル出力（N×15）から候補を取り出す。_dynamic_extract_candidates() の移植。
   * validW/validH: パディング前の有効領域（その外の中心を持つ検出は、パディング部の誤検出として捨てる）
   */
  function extractDynamicCandidates(data, rowCount, validW, validH, sx, sy, minConfFloor = 0.0) {
    const out = [];
    for (let r = 0; r < rowCount; r++) {
      const o = r * 15;
      const mx = data[o], my = data[o + 1], mw = data[o + 2], mh = data[o + 3], conf = data[o + 14];
      if (![mx, my, mw, mh, conf].every(Number.isFinite)) continue;
      if (mw <= 0.0 || mh <= 0.0) continue;

      const ccx = mx + mw * 0.5, ccy = my + mh * 0.5;
      if (ccx < 0.0 || ccy < 0.0 || ccx >= validW || ccy >= validH) continue;

      const bx = mx * sx, by = my * sy, bw = mw * sx, bh = mh * sy;
      if (bw < 16.0 || bh < 16.0) continue;
      const aspect = bw / bh;
      if (aspect < 0.50 || aspect > 1.35) continue;

      let required = Math.max(C.FACE_SCORE_THRESHOLD, minConfFloor);
      if (Math.min(mw, mh) < C.DYN_SMALL_FACE_PX) required = Math.max(required, C.DYN_SMALL_FACE_MIN_CONF);
      if (conf < required) continue;

      const touchesEdge = mx <= C.DYN_EDGE_MARGIN_PX || my <= C.DYN_EDGE_MARGIN_PX
        || mx + mw >= validW - C.DYN_EDGE_MARGIN_PX || my + mh >= validH - C.DYN_EDGE_MARGIN_PX;
      if (!(touchesEdge && conf >= C.DYN_EDGE_MIN_CONF)) {
        const lm = [];
        for (let i = 4; i < 14; i++) lm.push(data[o + i] * (i % 2 === 0 ? sx : sy));
        if (!validateFaceLandmarks(bw, bh, lm)) continue;
      }
      out.push({ raw: [bx, by, bx + bw, by + bh], confidence: clamp(conf, 0.0, 1.0), modelSize: Math.max(mw, mh) });
    }
    return out;
  }

  /** 信頼度の高い順に、重なりの大きい候補を除く。_merge_face_candidates() の移植 */
  function mergeFaceCandidates(cands) {
    if (cands.length <= 1) return cands.slice();
    const sorted = cands.map((c, i) => [c, i])
      .sort((x, y) => (y[0].confidence - x[0].confidence) || (x[1] - y[1]))
      .map((x) => x[0]);
    const kept = [];
    for (const cand of sorted) {
      const a = cand.raw;
      let dup = false;
      for (const other of kept) {
        const b = other.raw;
        if (iou(a, b) >= C.DYN_MERGE_IOU) { dup = true; break; }
        const iw = Math.max(0.0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
        const ih = Math.max(0.0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
        const smaller = Math.min(boxArea(a), boxArea(b));
        if (smaller > 0.0 && (iw * ih) / smaller >= C.DYN_MERGE_CONTAINMENT) { dup = true; break; }
      }
      if (!dup) kept.push(cand);
    }
    return kept;
  }

  /**
   * dynamic-input モデルによる顔検出の全体ロジック（detect_faces_dynamic の移植）。
   * 推論そのものは inferPrimary/inferCoarse（{data, rows} を返す）に委ね、モデルなしでもテストできる。
   * @returns {{box:number[], confidence:number}[]}  原画座標（パディング済み）
   */
  function detectDynamicLogic(origW, origH, maxDim, inferPrimary, inferCoarse) {
    if (!(origW > 0 && origH > 0)) return [];
    const { dw, dh } = detectionSize(origW, origH, maxDim);
    const sx = origW / dw, sy = origH / dh;

    const prim = inferPrimary(dw, dh);
    let cands = extractDynamicCandidates(prim.data, prim.rows, dw, dh, sx, sy, 0.0);

    const longSide = Math.max(dw, dh);
    if (longSide >= C.DYN_COARSE_DETECT_DIM * 1.25) {
      const need = cands.length === 0 || cands.some((c) => c.modelSize > C.DYN_COARSE_LARGE_FACE_TRIGGER);
      if (need) {
        const cscale = C.DYN_COARSE_DETECT_DIM / longSide;
        const cw = Math.max(1, pyRound(dw * cscale)), ch = Math.max(1, pyRound(dh * cscale));
        const co = inferCoarse(cw, ch);
        cands = cands.concat(extractDynamicCandidates(co.data, co.rows, cw, ch, origW / cw, origH / ch, C.DYN_COARSE_MIN_CONF));
      }
    }
    if (!cands.length) return [];

    const result = [];
    for (const cand of mergeFaceCandidates(cands)) {
      const [x1, y1, x2, y2] = cand.raw;
      const padW = (x2 - x1) * C.FACE_PADDING_X, padH = (y2 - y1) * C.FACE_PADDING_Y;
      const clipped = clipBox([x1 - padW, y1 - padH, x2 + padW, y2 + padH], origW, origH);
      if (clipped !== null) result.push({ box: clipped, confidence: cand.confidence });
    }
    return result;
  }

  // ===== モザイク =====
  /**
   * 確定済みトラックの顔領域にモザイクをかける（OpenCV.js 使用）。
   * mat: 8bit 多チャンネルの cv.Mat（RGBA/BGR どちらでも可。チャンネル順は結果に影響しない）
   */
  function applyMosaic(cv, mat, tracks) {
    const w = mat.cols, h = mat.rows;
    for (const track of tracks) {
      if (!track.confirmed) continue;
      const box = clipBox(track.getRenderBox(), w, h);
      if (box === null) continue;
      const x1 = clamp(Math.floor(box[0]), 0, w), y1 = clamp(Math.floor(box[1]), 0, h);
      const x2 = clamp(Math.ceil(box[2]), 0, w), y2 = clamp(Math.ceil(box[3]), 0, h);
      if (x2 <= x1 || y2 <= y1) continue;
      const rw = x2 - x1, rh = y2 - y1;
      if (rw < 2 || rh < 2) continue;

      const scale = Math.max(rw, rh) > 80 ? C.LARGE_FACE_MOSAIC_SCALE : C.SMALL_FACE_MOSAIC_SCALE;
      const sw = Math.max(1, pyRound(rw * scale)), sh = Math.max(1, pyRound(rh * scale));

      const roi = mat.roi(new cv.Rect(x1, y1, rw, rh));
      const small = new cv.Mat(), big = new cv.Mat();
      try {
        cv.resize(roi, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
        cv.resize(small, big, new cv.Size(rw, rh), 0, 0, cv.INTER_NEAREST);
        big.copyTo(roi);
      } finally {
        roi.delete(); small.delete(); big.delete();
      }
    }
  }

  // ===== ビットレート（軽量モード） =====
  function calculateCompactBitrate(inputFileSize, duration) {
    if (duration <= 0 || inputFileSize <= 0) return 800000;
    const targetBytes = Math.trunc(inputFileSize * C.COMPACT_TARGET_RATIO);
    const audioBytes = Math.trunc((duration * C.COMPACT_AUDIO_BITRATE) / 8.0);
    const reserveBytes = Math.max(4096, Math.trunc(targetBytes * C.CONTAINER_RESERVE_RATIO));
    const available = targetBytes - audioBytes - reserveBytes;
    const origBps = Math.trunc((inputFileSize * 8.0) / duration);
    const videoBps = available > 0
      ? Math.trunc((available * 8.0) / duration)
      : Math.max(48000, Math.trunc(origBps * 0.35));
    const minBps = Math.max(48000, Math.trunc(origBps * 0.20));
    const maxBps = Math.max(minBps, Math.trunc(origBps * 0.42));
    return Math.trunc(clamp(videoBps, minBps, maxBps));
  }

  // ===== ★ 入力の検証・無害化（ここから先はブラウザ版で追加） =====

  /** 表示・保存に使うファイル名から、制御文字・向きを変える文字(RLO 等)・パス区切りを除く */
  function sanitizeName(name, maxCodePoints = 120) {
    let s = String(name == null ? "" : name);
    try { s = s.normalize("NFC"); } catch (e) { /* 不正な文字列はそのまま */ }
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
    const cps = Array.from(s);
    if (cps.length > maxCodePoints) s = cps.slice(0, maxCodePoints).join("");
    return s;
  }

  /** ダウンロード名の本体（拡張子なし）。Windows の予約名も避ける */
  function safeBaseName(name, fallback = "video") {
    const noExt = String(name == null ? "" : name).replace(/\.[^./\\]{1,10}$/, "");
    let s = sanitizeName(noExt, 80);
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = "_" + s;
    return s || fallback;
  }

  /** 経過時間の表示用 */
  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + "秒";
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s ? `${m}分${s}秒` : `${m}分`;
    const h = Math.floor(m / 60);
    return `${h}時間${m % 60}分`;
  }

  /** 残り時間の見積もり。進捗が小さすぎる間は出さない（null） */
  function estimateRemaining(elapsedSec, progress01) {
    if (!(progress01 >= 0.03) || !(elapsedSec > 2)) return null;
    return elapsedSec * (1 - progress01) / progress01;
  }

  /**
   * 他のページに埋め込まれて(iframe 等)表示されているか。クリックジャッキング対策。
   * クロスオリジンの親があると top へのアクセスが例外になるため、例外も「埋め込まれている」とみなす。
   */
  function isFramed(win) {
    try { return win.top !== win.self; } catch (e) { return true; }
  }

  const QUALITIES = ["standard", "compact"];
  const ACCURACIES = ["high", "fast"];
  const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

  /** Blob/File の外形チェック（Worker に渡る file の検証） */
  function isBlobLike(f) {
    return !!f && typeof f === "object" && typeof f.size === "number" && Number.isFinite(f.size) && f.size > 0
      && typeof f.slice === "function" && f.size <= C.MAX_FILE_BYTES;
  }

  /**
   * Worker が受け取るメッセージを検証して、正規化した値を返す（不正なら例外）。
   * 想定外の型・範囲外の数値・未知の選択肢は、処理に入る前にここで止める。
   */
  function validateRequest(msg) {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") throw new Error("不正なメッセージです。");
    const out = { type: msg.type, id: msg.id };
    if (msg.id !== undefined && !(isFiniteNumber(msg.id) || typeof msg.id === "string")) throw new Error("不正なIDです。");
    switch (msg.type) {
      case "init":
        if (!(msg.modelBytes instanceof ArrayBuffer)) throw new Error("モデルデータの形式が不正です。");
        if (msg.modelBytes.byteLength < 100000 || msg.modelBytes.byteLength > 5000000) throw new Error("モデルファイルのサイズが不正です。");
        out.modelBytes = msg.modelBytes;
        return out;
      case "inspect":
        if (!isBlobLike(msg.file)) throw new Error("動画ファイルが不正です。");
        out.file = msg.file;
        return out;
      case "preview":
        if (!isBlobLike(msg.file)) throw new Error("動画ファイルが不正です。");
        if (!isFiniteNumber(msg.time)) throw new Error("時刻の指定が不正です。");
        out.file = msg.file;
        out.time = clamp(msg.time, 0, C.MAX_EXPORT_SECONDS);
        out.accuracy = ACCURACIES.includes(msg.accuracy) ? msg.accuracy : "high";
        return out;
      case "export":
        if (!isBlobLike(msg.file)) throw new Error("動画ファイルが不正です。");
        if (!QUALITIES.includes(msg.quality)) throw new Error("出力品質の指定が不正です。");
        out.file = msg.file;
        out.quality = msg.quality;
        out.accuracy = ACCURACIES.includes(msg.accuracy) ? msg.accuracy : "high";
        if (msg.maxSeconds !== undefined) {
          if (!isFiniteNumber(msg.maxSeconds) || msg.maxSeconds <= 0 || msg.maxSeconds > 3600) throw new Error("処理秒数の指定が不正です。");
          out.maxSeconds = msg.maxSeconds;
        }
        return out;
      case "detect-image":
        if (!msg.bitmap || !(msg.bitmap.width > 0 && msg.bitmap.height > 0) || msg.bitmap.width * msg.bitmap.height > C.MAX_PIXELS)
          throw new Error("画像が不正です。");
        out.bitmap = msg.bitmap;
        return out;
      case "cancel":
        return out;
      default:
        throw new Error("未知のメッセージです。");
    }
  }

  return {
    C, clamp, pyRound, alignUp, boxArea, boxCenter, boxSize, iou, normalizedCenterDistance, sizeSimilarity, clipBox,
    RobustFaceTrack, linearSumAssignment, matchTracksGreedy, matchTracksHungarian, matchTracksToDetections,
    updateTracksPool, validateFaceLandmarks, detectionSize, detectDim,
    extractDynamicCandidates, mergeFaceCandidates, detectDynamicLogic,
    applyMosaic, calculateCompactBitrate,
    sanitizeName, safeBaseName, formatDuration, estimateRemaining, validateRequest, isBlobLike, isFramed,
  };
});
