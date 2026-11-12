/* FaceMosaic Browser - pipeline.js
 * 1フレーム分の「検出 → 追跡 → モザイク」を行う。ブラウザ API 非依存（cv と検出器を注入）。
 * GPU バックエンド優先初期化、および速く動く人物（モーションブラー・大移動）の局所ROI再検出に対応。
 * Worker からも Node のテストからも同じコードが使われる。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FMPipeline = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * 推論 1 回。dynamic-input モデルは、入力の縦横を 32 の倍数にそろえて渡す
   * （右・下を黒で埋める。埋めた領域の検出は core 側で除外する）。
   * @param wrapper {det, size} 入力サイズの再設定を省くためのキャッシュ付き検出器
   * @param padMat  パディング用の再利用 Mat（null なら一時的に確保）
   * @returns {{data: Float32Array, rows: number}}  モデル入力座標での N×15
   */
  function inferMat(cv, core, wrapper, mat, padMat) {
    const unit = core.C.DYN_INPUT_ALIGN;
    const h = mat.rows, w = mat.cols;
    const ph = core.alignUp(h, unit), pw = core.alignUp(w, unit);
    let input = mat, tmpPad = null;
    if (ph !== h || pw !== w) {
      const dst = padMat || (tmpPad = new cv.Mat());
      cv.copyMakeBorder(mat, dst, 0, ph - h, 0, pw - w, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      input = dst;
    }
    if (!wrapper.size || wrapper.size[0] !== pw || wrapper.size[1] !== ph) {
      wrapper.det.setInputSize(new cv.Size(pw, ph));
      wrapper.size = [pw, ph];
    }
    const faces = new cv.Mat();
    try {
      wrapper.det.detect(input, faces);
      if (faces.rows > 0 && faces.cols >= 15) return { data: new Float32Array(faces.data32F), rows: faces.rows };
      return { data: new Float32Array(0), rows: 0 };
    } finally {
      faces.delete();
      if (tmpPad) tmpPad.delete();
    }
  }

  /** ブラウザ上で GPU（WebGPU / WebGL2）が利用可能な環境かどうかを判定する */
  function hasBrowserGpuEnv() {
    try {
      if (typeof navigator !== "undefined" && navigator.gpu) return true;
      if (typeof OffscreenCanvas !== "undefined") {
        const c = new OffscreenCanvas(1, 1);
        const gl = c.getContext("webgl2", { powerPreference: "high-performance" }) || c.getContext("webgl", { powerPreference: "high-performance" });
        if (gl && typeof gl.getParameter === "function") {
          const ext = gl.getExtension && gl.getExtension("WEBGL_lose_context");
          if (ext && typeof ext.loseContext === "function") ext.loseContext();
          return true;
        }
      }
    } catch (e) { /* Node 等では false */ }
    return false;
  }

  /**
   * cv.FaceDetectorYN を 1 つ作る。
   * GPU が使える環境では GPU ターゲット（WebNN / Vulkan / CUDA / OpenCL）を優先して試し、
   * 未対応ビルドの場合は CPU（DNN_BACKEND_OPENCV + DNN_TARGET_CPU）へ安全にフォールバックする。
   */
  function makeYuNet(cv, core, name, preferGpu = false) {
    const C = core.C;
    const size = new cv.Size(320, 320);
    const gpuAttempts = [];
    if (preferGpu) {
      if (cv.DNN_BACKEND_WEBNN !== undefined && cv.DNN_TARGET_OPENCL !== undefined) {
        gpuAttempts.push({ label: "WebNN(GPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_WEBNN, cv.DNN_TARGET_OPENCL), gpu: true });
      }
      if (cv.DNN_BACKEND_VKCOM !== undefined && cv.DNN_TARGET_VULKAN !== undefined) {
        gpuAttempts.push({ label: "Vulkan(GPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_VKCOM, cv.DNN_TARGET_VULKAN), gpu: true });
      }
      if (cv.DNN_BACKEND_CUDA !== undefined && cv.DNN_TARGET_CUDA_FP16 !== undefined) {
        gpuAttempts.push({ label: "CUDA-FP16(GPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_CUDA, cv.DNN_TARGET_CUDA_FP16), gpu: true });
      }
      if (cv.DNN_BACKEND_CUDA !== undefined && cv.DNN_TARGET_CUDA !== undefined) {
        gpuAttempts.push({ label: "CUDA(GPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_CUDA, cv.DNN_TARGET_CUDA), gpu: true });
      }
      if (cv.DNN_BACKEND_OPENCV !== undefined && cv.DNN_TARGET_OPENCL_FP16 !== undefined) {
        gpuAttempts.push({ label: "OpenCL-FP16(GPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_OPENCV, cv.DNN_TARGET_OPENCL_FP16), gpu: true });
      }
      if (cv.DNN_BACKEND_OPENCV !== undefined && cv.DNN_TARGET_OPENCL !== undefined) {
        gpuAttempts.push({ label: "OpenCL(GPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_OPENCV, cv.DNN_TARGET_OPENCL), gpu: true });
      }
    }
    const cpuAttempts = [
      { label: "OpenCV(WASM/CPU)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K, cv.DNN_BACKEND_OPENCV, cv.DNN_TARGET_CPU), gpu: false },
      { label: "OpenCV(Default)", fn: () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K), gpu: false },
      { label: "OpenCV(Basic)", fn: () => new cv.FaceDetectorYN(name, "", size), gpu: false },
    ];

    let det = null, chosenLabel = "OpenCV(WASM/CPU)", isGpu = false, lastErr = null;
    for (const item of gpuAttempts) {
      let candidate = null, probeMat = null, probeOut = null;
      try {
        candidate = item.fn();
        // 実際に1回推論して、ビルドが該当GPUバックエンドをサポートしているか確認する
        candidate.setInputSize(new cv.Size(64, 64));
        probeMat = cv.Mat.zeros(64, 64, cv.CV_8UC3);
        probeOut = new cv.Mat();
        candidate.detect(probeMat, probeOut);
        det = candidate;
        chosenLabel = item.label;
        isGpu = true;
        candidate = null;
        break;
      } catch (e) {
        lastErr = e;
      } finally {
        if (probeMat) { try { probeMat.delete(); } catch (e) {} }
        if (probeOut) { try { probeOut.delete(); } catch (e) {} }
        if (candidate && typeof candidate.delete === "function") { try { candidate.delete(); } catch (e) {} }
      }
    }

    if (!det) {
      for (const item of cpuAttempts) {
        try {
          det = item.fn();
          chosenLabel = item.label;
          isGpu = false;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
    }

    if (!det) throw new Error("YuNet モデルを読み込めませんでした: " + (lastErr && (lastErr.message || lastErr)));
    // どの生成経路でも、しきい値はデスクトップ版と同じにそろえる
    if (typeof det.setScoreThreshold === "function") det.setScoreThreshold(C.FACE_SCORE_THRESHOLD);
    if (typeof det.setNMSThreshold === "function") det.setNMSThreshold(C.FACE_NMS_THRESHOLD);
    if (typeof det.setTopK === "function") det.setTopK(C.FACE_TOP_K);
    return { det, size: null, backend: chosenLabel, gpu: isGpu };
  }

  /**
   * dynamic-input YuNet を「主検出用」と「粗スケール再検出用」の 2 つ作り、起動時に自己診断する。
   * （デスクトップ版 DynamicFaceDetector と同じ構成）
   */
  function createDynamicDetector(cv, core, modelBytes) {
    const name = "yunet_dynamic.onnx";
    try { cv.FS_unlink("/" + name); } catch (e) { /* 初回は存在しない */ }
    cv.FS_createDataFile("/", name, new Uint8Array(modelBytes), true, false, false);

    const tryGpu = hasBrowserGpuEnv();
    const primary = makeYuNet(cv, core, name, tryGpu);
    const coarse = makeYuNet(cv, core, name, tryGpu);
    try {
      // 形の違う入力で各 1〜3 回推論できることを確認する（モデルや OpenCV.js の不整合を早期に検出）
      for (const [h, w] of [[72, 104], [96, 160], [72, 104]]) {
        const z = cv.Mat.zeros(h, w, cv.CV_8UC3);
        try { inferMat(cv, core, primary, z, null); } finally { z.delete(); }
      }
      const z2 = cv.Mat.zeros(72, 104, cv.CV_8UC3);
      try { inferMat(cv, core, coarse, z2, null); } finally { z2.delete(); }
    } catch (e) {
      disposeDetector({ primary, coarse });
      throw new Error("顔認識モデルでの推論に失敗しました。モデルファイルが壊れているか、対応していない可能性があります。\n" + (e && (e.message || e)));
    }
    return { primary, coarse, backend: primary.backend, gpu: !!(primary.gpu || coarse.gpu) };
  }

  function disposeDetector(d) {
    for (const k of ["primary", "coarse"]) {
      const w = d && d[k];
      if (w && w.det && typeof w.det.delete === "function") { try { w.det.delete(); } catch (e) { /* 既に解放済み */ } }
    }
  }

  class FacePipeline {
    /**
     * @param cv        OpenCV.js
     * @param core      FMCore
     * @param detector  createDynamicDetector() の戻り値（または同じ形の {primary, coarse}）
     */
    constructor(cv, core, detector) {
      this.cv = cv;
      this.core = core;
      this.detector = detector;
      this.tracks = [];
      this.nextId = 1;
      this._w = 0; this._h = 0;
      this.rgba = null; this.bgr = null; this.small = null; this.pad = null; this.coarseMat = null;
    }

    resetTracking() { this.tracks = []; this.nextId = 1; }

    _ensure(w, h) {
      if (this._w === w && this._h === h && this.rgba) return;
      const oldW = this._w, oldH = this._h;
      this.dispose();
      // 解像度が切り替わった場合、既存トラックを破棄して異解像度間の誤追跡を防ぐ
      if (oldW > 0 && oldH > 0 && (oldW !== w || oldH !== h)) {
        this.tracks = [];
      }
      const cv = this.cv;
      this.rgba = new cv.Mat(h, w, cv.CV_8UC4);
      this.bgr = new cv.Mat();
      this.small = new cv.Mat();
      this.pad = new cv.Mat();
      this.coarseMat = new cv.Mat();
      this._w = w; this._h = h;
    }

    /**
     * 速く動く人物のトラックが通常検出で見失われた場合、予測位置の周辺領域（ROI）を原画から切り出して
     * モーションブラー耐性しきい値で局所再検出を行う。
     */
    _recoverMovingTracksRoi(unmatchedTracks) {
      const cv = this.cv, core = this.core, C = core.C;
      const coarseWrap = this.detector && this.detector.coarse;
      if (!coarseWrap || !coarseWrap.det || typeof coarseWrap.det.setScoreThreshold !== "function") return [];

      const recovered = [];
      // 処理負荷を抑えるため、速度の大きい確定トラックを最大2件まで局所再検出する
      const moving = unmatchedTracks
        .filter((t) => t.confirmed && t.missingCount <= 2 && Math.hypot(t.velocity[0], t.velocity[1]) >= 2.5)
        .sort((a, b) => Math.hypot(b.velocity[0], b.velocity[1]) - Math.hypot(a.velocity[0], a.velocity[1]))
        .slice(0, 2);
      if (!moving.length) return [];

      coarseWrap.det.setScoreThreshold(C.FAST_MOTION_SCORE_THRESHOLD);
      try {
        for (const t of moving) {
          const pred = t.predictedBox();
          const [cx, cy] = core.boxCenter(pred);
          const [bw, bh] = core.boxSize(pred);
          const speed = Math.hypot(t.velocity[0], t.velocity[1]);
          const halfW = Math.max(64, Math.min(this._w * 0.45, Math.max(bw, bh) * 1.6 + speed * 0.9));
          const halfH = Math.max(64, Math.min(this._h * 0.45, Math.max(bw, bh) * 1.6 + speed * 0.9));

          const rx1 = core.clamp(Math.floor(cx - halfW), 0, this._w - 2);
          const ry1 = core.clamp(Math.floor(cy - halfH), 0, this._h - 2);
          const rx2 = core.clamp(Math.ceil(cx + halfW), rx1 + 2, this._w);
          const ry2 = core.clamp(Math.ceil(cy + halfH), ry1 + 2, this._h);
          const rw = rx2 - rx1, rh = ry2 - ry1;
          if (rw < 32 || rh < 32) continue;

          const { dw: rdw, dh: rdh } = core.detectionSize(rw, rh, 256);
          const roi = this.bgr.roi(new cv.Rect(rx1, ry1, rw, rh));
          try {
            cv.resize(roi, this.coarseMat, new cv.Size(rdw, rdh), 0, 0, cv.INTER_AREA);
          } finally {
            roi.delete();
          }
          const out = inferMat(cv, core, coarseWrap, this.coarseMat, this.pad);
          if (out.rows > 0) {
            const sx = rw / rdw, sy = rh / rdh;
            for (let r = 0; r < out.rows; r++) {
              const o = r * 15;
              const mx = out.data[o], my = out.data[o + 1], mw = out.data[o + 2], mh = out.data[o + 3], conf = out.data[o + 14];
              if (![mx, my, mw, mh, conf].every(Number.isFinite) || mw <= 0 || mh <= 0) continue;
              if (conf < C.FAST_MOTION_SCORE_THRESHOLD) continue;
              const ccx = mx + mw * 0.5, ccy = my + mh * 0.5;
              if (ccx < 0 || ccy < 0 || ccx >= rdw || ccy >= rdh) continue;
              const bx = rx1 + mx * sx, by = ry1 + my * sy, fbw = mw * sx, fbh = mh * sy;
              if (fbw < 14 || fbh < 14) continue;
              const aspect = fbw / fbh;
              if (aspect < C.FAST_MOTION_MIN_ASPECT || aspect > C.FAST_MOTION_MAX_ASPECT) continue;
              const padW = fbw * C.FACE_PADDING_X, padH = fbh * C.FACE_PADDING_Y;
              const clipped = core.clipBox([bx - padW, by - padH, bx + fbw + padW, by + fbh + padH], this._w, this._h);
              if (clipped && core.fastMotionMatchScore(t, clipped) >= C.FAST_TRACK_MIN_MATCH_SCORE) {
                recovered.push({ box: clipped, confidence: core.clamp(conf, 0.0, 1.0) });
              }
            }
          }
        }
      } finally {
        coarseWrap.det.setScoreThreshold(C.FACE_SCORE_THRESHOLD);
      }
      return recovered;
    }

    /** 検出（原画サイズの座標で [{box, confidence}] を返す）。this.rgba に画像が入っていること */
    _detect(maxDim) {
      const cv = this.cv, core = this.core;
      const { dw, dh, resized } = core.detectionSize(this._w, this._h, maxDim);
      cv.cvtColor(this.rgba, this.bgr, cv.COLOR_RGBA2BGR);
      let target = this.bgr;
      if (resized) {
        cv.resize(this.bgr, this.small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
        target = this.small;
      }
      let lastPrim = null;
      let dets = core.detectDynamicLogic(
        this._w, this._h, maxDim,
        () => {
          lastPrim = inferMat(cv, core, this.detector.primary, target, this.pad);
          return lastPrim;
        },
        (cw, ch) => {
          cv.resize(target, this.coarseMat, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA);
          return inferMat(cv, core, this.detector.coarse, this.coarseMat, this.pad);
        },
      );

      // 移動中の既存トラックで未検出のものがあれば、高速移動・モーションブラー救済を行う
      if (this.tracks.length > 0) {
        const unmatched = this.tracks.filter((t) => {
          const speed = Math.hypot(t.velocity[0], t.velocity[1]);
          if (speed < 1.5) return false;
          return !dets.some((d) => t.matchScore(d.box) >= core.C.TRACK_MIN_MATCH_SCORE || core.fastMotionMatchScore(t, d.box) >= core.C.FAST_TRACK_MIN_MATCH_SCORE);
        });
        if (unmatched.length > 0 && lastPrim && lastPrim.rows > 0) {
          const recFromPrim = core.extractMotionRecoveryCandidates(
            lastPrim.data, lastPrim.rows, dw, dh, this._w / dw, this._h / dh, unmatched, this._w, this._h
          );
          for (const rc of recFromPrim) {
            if (!dets.some((d) => core.iou(d.box, rc.box) >= 0.30)) dets.push(rc);
          }
        }
        const stillUnmatched = unmatched.filter((t) =>
          !dets.some((d) => t.matchScore(d.box) >= core.C.TRACK_MIN_MATCH_SCORE || core.fastMotionMatchScore(t, d.box) >= core.C.FAST_TRACK_MIN_MATCH_SCORE)
        );
        if (stillUnmatched.length > 0) {
          const roiRec = this._recoverMovingTracksRoi(stillUnmatched);
          for (const rc of roiRec) {
            if (!dets.some((d) => core.iou(d.box, rc.box) >= 0.30)) dets.push(rc);
          }
        }
      }
      return dets;
    }

    /** 追跡・モザイクをせず、検出結果だけを返す（診断・検証用）。 */
    detectOnly(rgbaBytes, w, h, maxDim) {
      if (!(w > 0 && h > 0) || rgbaBytes.length < w * h * 4) throw new Error("フレームのサイズが不正です。");
      this._ensure(w, h);
      this.rgba.data.set(rgbaBytes.subarray ? rgbaBytes.subarray(0, w * h * 4) : rgbaBytes);
      return this._detect(maxDim);
    }

    /**
     * 1フレームを処理する。
     * 検出が例外になったフレームも、「検出なし」として追跡を進める（既存のトラックは予測位置で継続し、
     * モザイクも掛かる）。顔が映ったまま出力されるのを防ぐため。例外は detectError として返す。
     * @param {Uint8ClampedArray|Uint8Array} rgbaBytes  w*h*4 の画素（mosaic=true の場合は結果が書き戻される）
     * @param {boolean} mosaic  false なら検出と追跡の更新のみ（プレビューの助走フレーム用）
     * @param {number[][]} manualRects  手動モザイクの範囲（画素座標 [x1,y1,x2,y2]）。顔モザイクの後に重ねる
     * @returns {{faces: number, tracks: number, detectError: (Error|null)}}
     */
    processFrame(rgbaBytes, w, h, maxDim, mosaic = true, manualRects = []) {
      if (!(w > 0 && h > 0) || rgbaBytes.length < w * h * 4) throw new Error("フレームのサイズが不正です。");
      this._ensure(w, h);
      this.rgba.data.set(rgbaBytes.subarray ? rgbaBytes.subarray(0, w * h * 4) : rgbaBytes);

      let dets = [], detectError = null;
      try { dets = this._detect(maxDim); } catch (e) { detectError = e; }
      const r = this.core.updateTracksPool(this.tracks, dets, this.nextId, true, true);
      this.tracks = r.tracks; this.nextId = r.nextId;

      if (mosaic) {
        this.core.applyMosaic(this.cv, this.rgba, this.tracks);
        this.core.applyManualRects(this.cv, this.rgba, manualRects);
        rgbaBytes.set(this.rgba.data);
      }
      return { faces: dets.length, tracks: this.tracks.length, detectError };
    }

    /**
     * 直近に processFrame したフレームへ、現在の確定トラックと手動範囲のモザイクを適用し、画素(コピー)を返す。
     * プレビューの最終フレーム用（助走フレームは mosaic=false で流し、最後だけここで適用する）。
     */
    renderCurrent(manualRects = []) {
      if (!this.rgba) throw new Error("処理済みフレームがありません。");
      // 内部の画像は書き換えない（何度呼んでも同じ結果）。
      // 注意: OpenCV.js 5.0 の Mat.clone() は深いコピーではなくデータを共有するため、copyTo を使う。
      const tmp = new this.cv.Mat();
      this.rgba.copyTo(tmp);
      try {
        this.core.applyMosaic(this.cv, tmp, this.tracks);
        this.core.applyManualRects(this.cv, tmp, manualRects);
        return new Uint8ClampedArray(tmp.data);
      } finally {
        tmp.delete();
      }
    }

    dispose() {
      for (const k of ["rgba", "bgr", "small", "pad", "coarseMat"]) {
        if (this[k]) { try { this[k].delete(); } catch (e) { /* 既に解放済み */ } this[k] = null; }
      }
      this._w = this._h = 0;
    }
  }

  return { createDynamicDetector, disposeDetector, FacePipeline, inferMat, hasBrowserGpuEnv };
});
