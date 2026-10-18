/* FaceMosaic Browser - app.js（メインスレッド: 画面の制御のみ。重い処理は worker.js）
 *
 * セキュリティ方針:
 *  - HTML を文字列で組み立てない（innerHTML 等を使わない）。ファイル名などは必ず textContent で表示する。
 *  - 他のページに埋め込まれた（iframe）場合は動作しない（クリックジャッキング対策）。
 *  - ブラウザの保存領域（localStorage / IndexedDB / Cookie）を使わない。通信は自分のサイトのモデル取得のみ。
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- フレーム検査
  if (FMCore.isFramed(window)) {
    const box = document.createElement("div");
    box.className = "frame-blocked";
    box.textContent = "セキュリティのため、他のページに埋め込まれた状態では動作しません。このページを直接開いてください。";
    document.body.replaceChildren(box);
    return;
  }
  document.documentElement.classList.add("fm-ok");
  const bootMsg = document.getElementById("boot");
  if (bootMsg) bootMsg.remove();

  // ---------------------------------------------------------------- 定数
  const C = FMCore.C;
  const MODEL_URL = "models/" + C.MODEL_FILENAME;
  const UNSUPPORTED_EXT = [".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp", ".ts", ".mts", ".m2ts"];
  const INIT_TIMEOUT_MS = 120000;
  const INSPECT_TIMEOUT_MS = 60000;
  const WATCHDOG_MS = 120000;           // 処理中にこの時間、進捗が全く無ければ停止とみなす
  const WATCHDOG_CHECK_MS = 5000;

  const $ = (id) => document.getElementById(id);
  const el = {
    banner: $("banner"), drop: $("drop"), dropTitle: $("dropTitle"), dropHint: $("dropHint"), fileInput: $("fileInput"),
    fileMeta: $("fileMeta"), changeBtn: $("changeBtn"), empty: $("empty"), canvas: $("previewCanvas"),
    timeline: $("timeline"), slider: $("slider"), timeLabel: $("timeLabel"), previewNote: $("previewNote"),
    quality: $("quality"), accuracy: $("accuracy"), engineState: $("engineState"),
    modelPick: $("modelPick"), modelBtn: $("modelBtn"), modelInput: $("modelInput"), diagBtn: $("diagBtn"),
    exportBtn: $("exportBtn"), cancelBtn: $("cancelBtn"), progress: $("progress"), blocks: $("blocks"),
    progText: $("progText"), progPct: $("progPct"), result: $("result"), resultVideo: $("resultVideo"),
    resultSummary: $("resultSummary"), resultWarn: $("resultWarn"), downloadBtn: $("downloadBtn"),
  };

  const S = {
    worker: null,
    engine: "loading",            // loading | need-model | ready | failed
    file: null, info: null,
    inspecting: false, processing: false,
    previewInFlight: false, previewPending: false, previewTimer: null, previewId: 0,
    resultUrl: null, nextId: 1, lastActivity: 0,
    waiters: new Map(),
    outputName: "video",
    downloadName: "video_mosaic.mp4",
  };

  // ---------------------------------------------------------------- 進捗ブロック
  const BLOCKS = 50;
  for (let i = 0; i < BLOCKS; i++) el.blocks.appendChild(document.createElement("i"));
  function setProgress(pct, text) {
    const on = Math.floor((pct / 100) * BLOCKS);
    [...el.blocks.children].forEach((b, i) => { b.className = i < on ? "on" : (i === on && pct > 0 && pct < 100 ? "edge" : ""); });
    el.progPct.textContent = Math.floor(pct) + "%";
    el.progText.textContent = text || "";
  }

  // ---------------------------------------------------------------- 汎用
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60, p = (v) => String(v).padStart(2, "0");
    return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");

  /** kind: "error"（既定）| "info" | "warn"。本文は必ず textContent で入れる */
  function showBanner(msg, kind) {
    el.banner.textContent = msg;
    el.banner.className = "status " + (kind === "info" ? "ok" : kind === "warn" ? "warn" : "error");
    el.banner.hidden = false;
  }
  const hideBanner = () => { el.banner.hidden = true; };
  const isErrorShown = () => !el.banner.hidden && el.banner.classList.contains("error");

  function reportUnexpected(detail) {
    if (isErrorShown()) return;                       // 既に原因が表示されていれば上書きしない
    showBanner("予期しないエラーが発生しました。ページを再読み込みして、もう一度お試しください。\n" + String(detail || ""));
  }
  window.addEventListener("error", (e) => reportUnexpected(e && e.message));
  window.addEventListener("unhandledrejection", (e) => reportUnexpected(e && e.reason && (e.reason.message || e.reason)));

  function updateControls() {
    const ready = S.engine === "ready";
    const canPick = ready && !S.processing && !S.inspecting;
    el.fileInput.disabled = !canPick;
    el.drop.classList.toggle("disabled", !canPick);
    el.exportBtn.disabled = !ready || !S.file || S.processing || S.inspecting;
    el.cancelBtn.disabled = !S.processing;
    el.quality.disabled = S.processing;
    el.accuracy.disabled = S.processing;
    el.slider.disabled = S.processing;
    el.changeBtn.disabled = !canPick;
    if (ready) el.dropTitle.textContent = "動画をここにドロップ、またはクリックして選択";
    else if (S.engine === "need-model") el.dropTitle.textContent = "顔認識モデルを読み込めません";
    else if (S.engine === "failed") el.dropTitle.textContent = "エンジンを起動できません";
    else el.dropTitle.textContent = "エンジンを準備しています…";
  }

  function setEngine(state, text) {
    S.engine = state;
    el.engineState.textContent = text;
    el.engineState.className = "status" + (state === "ready" ? " ok" : (state === "failed" || state === "need-model") ? " error" : "");
    el.modelPick.hidden = state !== "need-model";
    updateControls();
  }

  // ---------------------------------------------------------------- 動作環境
  function checkEnvironment() {
    const problems = [];
    if (location.protocol === "file:") problems.push("ファイルを直接開いても動きません。Web サーバー経由（https:// または http://localhost）で開いてください。");
    else if (window.isSecureContext === false) problems.push("安全な接続（https）で開く必要があります。");
    if (typeof Worker === "undefined") problems.push("このブラウザは Web Worker に対応していません。");
    if (typeof OffscreenCanvas === "undefined") problems.push("このブラウザは OffscreenCanvas に対応していません。");
    if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined")
      problems.push("このブラウザは動画の変換機能（WebCodecs）に対応していません。パソコンの最新の Chrome または Edge をお使いください。");
    return problems;
  }

  // ---------------------------------------------------------------- Worker 通信
  function send(msg, transfer) {
    try {
      S.worker.postMessage(msg, transfer || []);
    } catch (e) {
      throw new Error("エンジンへのデータ送信に失敗しました。" + (e && e.message ? e.message : ""));
    }
  }

  function request(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = S.nextId++;
      const timer = setTimeout(() => {
        S.waiters.delete(id);
        reject(new Error("エンジンから応答がありませんでした（タイムアウト）。"));
      }, timeoutMs);
      S.waiters.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { send({ ...msg, id }); } catch (e) { clearTimeout(timer); S.waiters.delete(id); reject(e); }
    });
  }

  function onWorkerMessage(ev) {
    const m = ev.data || {};
    S.lastActivity = Date.now();
    switch (m.type) {
      case "ready": {
        const w = S.waiters.get("init"); if (w) { S.waiters.delete("init"); w.resolve(); }
        break;
      }
      case "inspected": {
        const w = S.waiters.get(m.id); if (w) { S.waiters.delete(m.id); w.resolve(m.info); }
        break;
      }
      case "preview": onPreview(m); break;
      case "preview-skipped": S.previewInFlight = false; break;
      case "progress": setProgress(m.value, m.text); break;
      case "done": onDone(m); break;
      case "canceled": onCanceled(); break;
      case "error": onWorkerError(m); break;
      default: break;
    }
  }

  function onWorkerError(m) {
    const msg = String(m.message || "不明なエラー");
    if (m.for === "init") {
      const w = S.waiters.get("init"); if (w) { S.waiters.delete("init"); w.reject(new Error(msg)); }
    } else if (m.for === "inspect") {
      const w = S.waiters.get(m.id); if (w) { S.waiters.delete(m.id); w.reject(new Error(msg)); }
    } else if (m.for === "preview") {
      S.previewInFlight = false;
      if (m.id === S.previewId) showBanner("プレビューを表示できません。\n" + msg);
      if (S.previewPending) pumpPreview();
    } else if (m.for === "export") {
      S.processing = false; el.progress.hidden = true;
      showBanner("処理に失敗しました。\n" + msg);
      updateControls();
    } else {
      showBanner(msg);
    }
  }

  function terminateWorker() {
    if (S.worker) { try { S.worker.terminate(); } catch (e) { /* 既に終了 */ } }
  }

  function onWorkerCrash(detail) {
    // Worker 自体の読み込み失敗・異常終了（ファイル欠落、メモリ不足、応答停止など）
    const wasProcessing = S.processing;
    S.processing = false; S.inspecting = false; S.previewInFlight = false;
    for (const [, w] of S.waiters) w.reject(new Error(detail));
    S.waiters.clear();
    el.progress.hidden = true;
    terminateWorker();
    setEngine("failed", "停止しました（ページを再読み込みしてください）");
    showBanner((wasProcessing ? "処理中にエンジンが停止しました。メモリ不足の可能性があります。\n" : "エンジンを起動できません。\n") + detail);
  }

  // 処理が止まっていないかを見張る（顔検出やエンコードが固まった場合に、画面が固まったままにならないようにする）
  setInterval(() => {
    if (S.processing && S.lastActivity && Date.now() - S.lastActivity > WATCHDOG_MS) {
      onWorkerCrash(`処理が${Math.round(WATCHDOG_MS / 60000)}分以上進みませんでした。動画を短くするか、「顔検出の精度」を「高速」にしてお試しください。`);
    }
  }, WATCHDOG_CHECK_MS);

  // ---------------------------------------------------------------- エンジン起動
  async function loadModelBytes() {
    const res = await fetch(MODEL_URL, { cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return checkModelSize(await res.arrayBuffer());
  }
  function checkModelSize(buf) {
    // 厳密な確認（SHA-256）は Worker 側で行う。ここは明らかな間違いを早めに知らせるための簡易チェック
    if (!buf || buf.byteLength !== C.MODEL_SIZE)
      throw new Error(`モデルファイルが想定のもの（${C.MODEL_FILENAME}、${C.MODEL_SIZE}バイト）と一致しません（${buf ? buf.byteLength : 0}バイト）。`);
    return buf;
  }

  async function initEngine(modelBytes) {
    setEngine("loading", "読み込み中…（初回は約13MBのダウンロードがあります）");
    const waiting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { S.waiters.delete("init"); reject(new Error("エンジンの起動がタイムアウトしました。")); }, INIT_TIMEOUT_MS);
      S.waiters.set("init", { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
    try {
      send({ type: "init", modelBytes }, [modelBytes]);
      await waiting;
      setEngine("ready", "利用可能");
    } catch (e) {
      setEngine("failed", "起動に失敗しました");
      showBanner("顔認識エンジンを起動できません。\n" + e.message);
    }
  }

  async function startEngine() {
    const problems = checkEnvironment();
    if (problems.length) {
      setEngine("failed", "この環境では利用できません");
      showBanner(problems.join("\n"));
      return;
    }
    try {
      S.worker = new Worker("js/worker.js");
    } catch (e) {
      setEngine("failed", "起動に失敗しました");
      showBanner("エンジンを起動できません。\n" + (e.message || e));
      return;
    }
    S.worker.onmessage = onWorkerMessage;
    S.worker.onerror = (e) => onWorkerCrash("js/worker.js または vendor/ のファイルが正しく配置されているか確認してください。\n" + (e && e.message ? e.message : ""));
    S.worker.onmessageerror = () => onWorkerCrash("エンジンとの通信に失敗しました。");

    let bytes;
    try {
      bytes = await loadModelBytes();
    } catch (e) {
      setEngine("need-model", "モデルファイルが見つかりません");
      showBanner(`顔認識モデル（models/${C.MODEL_FILENAME}）を読み込めませんでした。\n${e.message}\n管理者の方は README の手順でモデルを配置してください。お手元にこのファイルがある場合は、右の「モデルファイルを選択」から指定できます。`, "info");
      return;
    }
    await initEngine(bytes);
  }

  el.modelBtn.addEventListener("click", () => el.modelInput.click());
  el.modelInput.addEventListener("change", async () => {
    const f = el.modelInput.files && el.modelInput.files[0];
    el.modelInput.value = "";
    if (!f) return;
    try {
      hideBanner();
      await initEngine(checkModelSize(await f.arrayBuffer()));
    } catch (e) {
      showBanner(e.message);
    }
  });
  el.diagBtn.addEventListener("click", () => { location.href = "selfcheck.html"; });

  // ---------------------------------------------------------------- ファイル選択
  el.changeBtn.addEventListener("click", () => { if (!el.fileInput.disabled) el.fileInput.click(); });
  el.fileInput.addEventListener("change", () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = "";
    if (f) handleFile(f);
  });
  const canPickNow = () => S.engine === "ready" && !S.processing && !S.inspecting;
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (canPickNow() && !S.file) el.drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("dragover"); }));
  document.addEventListener("drop", (e) => {
    if (!canPickNow()) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  async function handleFile(file) {
    hideBanner();
    const shownName = FMCore.sanitizeName(file.name) || "video";
    const ext = "." + (shownName.split(".").pop() || "").toLowerCase();
    if (UNSUPPORTED_EXT.includes(ext)) {
      return showBanner(`${ext} 形式は未対応です。mp4（H.264）などに変換してお試しください。\n対応: mp4 / mov / m4v / webm / mkv`);
    }
    if (!(file.size > 0)) return showBanner("空のファイルです。");
    if (file.size > C.MAX_FILE_BYTES) return showBanner(`ファイルが大きすぎます（${(file.size / 1073741824).toFixed(1)}GB）。4GB 以下にしてください。`);
    if (file.size > C.WARN_FILE_BYTES) showBanner("容量の大きい動画です。処理に時間がかかり、メモリ不足で止まることがあります。", "warn");

    resetStage(true);
    S.inspecting = true; updateControls();
    el.fileMeta.hidden = false; el.fileMeta.textContent = shownName + "　動画を解析中…";
    let info;
    try {
      info = await request({ type: "inspect", file }, INSPECT_TIMEOUT_MS);
    } catch (e) {
      S.inspecting = false; el.fileMeta.hidden = true; updateControls();
      return showBanner("この動画を読み込めません。\n" + e.message);
    }
    S.inspecting = false;
    if (!info.decodable) {
      el.fileMeta.hidden = true; updateControls();
      return showBanner("この動画のコーデック（" + (info.codec || "不明") + "）はブラウザで再生できないため処理できません。\nmp4（H.264）に変換してお試しください。");
    }

    S.file = file; S.info = info;
    S.outputName = FMCore.safeBaseName(file.name);
    el.fileMeta.textContent = `${shownName}　${fmtSize(file.size)}　${info.width}×${info.height}　${fmtTime(info.duration)}` + (info.hasAudio ? "" : "　音声なし");
    el.drop.hidden = true; el.changeBtn.hidden = false; el.timeline.hidden = false; el.previewNote.hidden = false;
    el.slider.max = String(Math.max(0, info.duration)); el.slider.value = "0";
    updateTimeLabel(); updateControls();
    pumpPreview();
  }

  // ---------------------------------------------------------------- プレビュー（同時に1つだけ・最新の要求を優先）
  function updateTimeLabel() {
    el.timeLabel.textContent = `${fmtTime(parseFloat(el.slider.value))} / ${fmtTime(S.info ? S.info.duration : 0)}`;
  }
  el.slider.addEventListener("input", () => {
    updateTimeLabel();
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(pumpPreview, 140);
  });
  el.accuracy.addEventListener("change", () => { if (S.file) pumpPreview(); });

  function pumpPreview() {
    if (!S.file || S.processing) return;
    if (S.previewInFlight) { S.previewPending = true; return; }
    S.previewInFlight = true; S.previewPending = false;
    S.previewId = S.nextId++;
    S.lastActivity = Date.now();
    try {
      send({ type: "preview", file: S.file, time: parseFloat(el.slider.value) || 0, accuracy: el.accuracy.value, id: S.previewId });
    } catch (e) {
      S.previewInFlight = false;
      showBanner(e.message);
    }
  }

  async function drawPreview(blob) {
    const bmp = await createImageBitmap(blob);
    try {
      el.canvas.width = bmp.width; el.canvas.height = bmp.height;
      const ctx = el.canvas.getContext("2d");
      if (!ctx) throw new Error("描画できません。");
      ctx.drawImage(bmp, 0, 0);
    } finally {
      if (bmp.close) bmp.close();
    }
    el.canvas.hidden = false; el.empty.hidden = true;
  }

  async function onPreview(m) {
    S.previewInFlight = false;
    if (m.id === S.previewId && S.file) {
      try { await drawPreview(m.blob); } catch (e) { showBanner("プレビューを表示できません。\n" + (e.message || e)); }
    }
    if (S.previewPending) pumpPreview();
  }

  // ---------------------------------------------------------------- 書き出し
  el.exportBtn.addEventListener("click", () => {
    if (!S.file || S.processing || S.engine !== "ready") return;
    hideBanner(); clearResult();
    S.processing = true; S.lastActivity = Date.now(); updateControls();
    el.progress.hidden = false; setProgress(0, "処理を開始しています…");
    try {
      send({ type: "export", file: S.file, quality: el.quality.value, accuracy: el.accuracy.value });
    } catch (e) {
      S.processing = false; el.progress.hidden = true; updateControls();
      showBanner(e.message);
    }
  });
  el.cancelBtn.addEventListener("click", () => {
    if (!S.processing) return;
    el.cancelBtn.disabled = true;
    try { send({ type: "cancel" }); } catch (e) { showBanner(e.message); }
  });

  function onDone(m) {
    S.processing = false;
    el.progress.hidden = true;
    const blob = new Blob([m.buffer], { type: "video/mp4" });
    if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
    S.resultUrl = URL.createObjectURL(blob);
    S.downloadName = S.outputName + (el.quality.value === "compact" ? "_mosaic_0.4x" : "_mosaic") + ".mp4";
    el.result.hidden = false;
    el.resultVideo.src = S.resultUrl;
    el.downloadBtn.textContent = `ダウンロード（${fmtSize(m.size)}）`;
    const codecLabel = { avc: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1" }[m.codec] || String(m.codec);
    el.resultSummary.textContent = `元のサイズの${m.ratioPct}%　${codecLabel}　${m.frames}フレーム`
      + (m.codec === "hevc" ? "　※HEVCはブラウザによってはここで再生できません。ダウンロードしてご確認ください。" : "");
    if (m.warnings && m.warnings.length) { el.resultWarn.textContent = m.warnings.join("\n"); el.resultWarn.hidden = false; }
    else el.resultWarn.hidden = true;
    updateControls();
  }

  el.downloadBtn.addEventListener("click", () => {
    if (!S.resultUrl) return;
    const a = document.createElement("a");
    a.href = S.resultUrl; a.download = S.downloadName; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  });

  function onCanceled() {
    S.processing = false;
    el.progress.hidden = true;
    showBanner("処理を中断しました。", "info");
    updateControls();
  }

  function clearResult() {
    el.result.hidden = true;
    el.resultVideo.removeAttribute("src");
    if (el.resultVideo.load) el.resultVideo.load();
    if (S.resultUrl) { URL.revokeObjectURL(S.resultUrl); S.resultUrl = null; }
  }

  // ---------------------------------------------------------------- リセット
  function resetStage(keepBanner) {
    S.file = null; S.info = null;
    clearTimeout(S.previewTimer);
    S.previewPending = false;
    el.canvas.hidden = true; el.empty.hidden = false;
    el.timeline.hidden = true; el.fileMeta.hidden = true; el.previewNote.hidden = true; el.changeBtn.hidden = true;
    el.drop.hidden = false; el.progress.hidden = true;
    clearResult();
    if (!keepBanner) hideBanner();
    updateControls();
  }

  window.addEventListener("beforeunload", (e) => { if (S.processing) { e.preventDefault(); e.returnValue = ""; } });

  updateControls();
  startEngine();
})();
