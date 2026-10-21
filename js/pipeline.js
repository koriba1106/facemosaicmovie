/* FaceMosaic Browser - pipeline.js
 * 1フレーム分の「検出 → 追跡 → モザイク」を行う。ブラウザ API 非依存（cv と検出器を注入）。
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

  /** cv.FaceDetectorYN を 1 つ作る。版による引数の違いに備えて段階的にフォールバックする */
  function makeYuNet(cv, core, name) {
    const C = core.C;
    const size = new cv.Size(320, 320);
    const attempts = [
      () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K,
        cv.DNN_BACKEND_OPENCV, cv.DNN_TARGET_CPU),
      () => new cv.FaceDetectorYN(name, "", size, C.FACE_SCORE_THRESHOLD, C.FACE_NMS_THRESHOLD, C.FACE_TOP_K),
      () => new cv.FaceDetectorYN(name, "", size),
    ];
    let det = null, lastErr = null;
    for (const make of attempts) {
      try { det = make(); break; } catch (e) { lastErr = e; }
    }
    if (!det) throw new Error("YuNet モデルを読み込めませんでした: " + (lastErr && (lastErr.message || lastErr)));
    // どの生成経路でも、しきい値はデスクトップ版と同じにそろえる
    if (typeof det.setScoreThreshold === "function") det.setScoreThreshold(C.FACE_SCORE_THRESHOLD);
    if (typeof det.setNMSThreshold === "function") det.setNMSThreshold(C.FACE_NMS_THRESHOLD);
    if (typeof det.setTopK === "function") det.setTopK(C.FACE_TOP_K);
    return { det, size: null };
  }

  /**
   * dynamic-input YuNet を「主検出用」と「粗スケール再検出用」の 2 つ作り、起動時に自己診断する。
   * （デスクトップ版 DynamicFaceDetector と同じ構成）
   */
  function createDynamicDetector(cv, core, modelBytes) {
    const name = "yunet_dynamic.onnx";
    try { cv.FS_unlink("/" + name); } catch (e) { /* 初回は存在しない */ }
    cv.FS_createDataFile("/", name, new Uint8Array(modelBytes), true, false, false);

    const primary = makeYuNet(cv, core, name);
    const coarse = makeYuNet(cv, core, name);
    try {
      // 形の違う入力で各 1〜3 回推論できることを確認する（モデルや OpenCV.js の不整合を早期に検出）
      for (const [h, w] of [[72, 104], [96, 160], [72, 104]]) {
        const z = cv.Mat.zeros(h, w, cv.CV_8UC3);
        try { inferMat(cv, core, primary, z, null); } finally { z.delete(); }
      }
      const z2 = cv.Mat.zeros(72, 104, cv.CV_8UC3);
      try { inferMat(cv, core, coarse, z2, null); } finally { z2.delete(); }
    } catch (e) {
      throw new Error("顔認識モデルでの推論に失敗しました。モデルファイルが壊れているか、対応していない可能性があります。\n" + (e && (e.message || e)));
    }
    return { primary, coarse };
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
      this.dispose();
      const cv = this.cv;
      this.rgba = new cv.Mat(h, w, cv.CV_8UC4);
      this.bgr = new cv.Mat();
      this.small = new cv.Mat();
      this.pad = new cv.Mat();
      this.coarseMat = new cv.Mat();
      this._w = w; this._h = h;
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
      return core.detectDynamicLogic(
        this._w, this._h, maxDim,
        () => inferMat(cv, core, this.detector.primary, target, this.pad),
        (cw, ch) => {
          cv.resize(target, this.coarseMat, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA);
          return inferMat(cv, core, this.detector.coarse, this.coarseMat, this.pad);
        },
      );
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
      const r = this.core.updateTracksPool(this.tracks, dets, this.nextId, true);
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

  return { createDynamicDetector, disposeDetector, FacePipeline, inferMat };
});
