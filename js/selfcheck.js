/* FaceMosaic Browser - selfcheck.js（動作診断）
 * 実ブラウザ・実モデルで「動くか」を順に確認する。動画は外部に送信しない。 */
(() => {
  "use strict";

  if (FMCore.isFramed(window)) {
    const box = document.createElement("div");
    box.className = "frame-blocked";
    box.textContent = "セキュリティのため、他のページに埋め込まれた状態では動作しません。";
    document.body.replaceChildren(box);
    return;
  }
  document.documentElement.classList.add("fm-ok");
  const boot = document.getElementById("boot"); if (boot) boot.remove();

  const C = FMCore.C;
  const FACE_B64 = "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";   // 診断用の顔画像（scikit-image 同梱の宇宙飛行士の写真。NASA、パブリックドメイン）
  const $ = (id) => document.getElementById(id);
  const report = [];
  const results = [];
  let videoFile = null;

  $("backBtn").addEventListener("click", () => { location.href = "index.html"; });
  $("vid").addEventListener("change", (e) => {
    videoFile = (e.target.files && e.target.files[0]) || null;
    $("vidTitle").textContent = videoFile ? "通しテスト用の動画: " + FMCore.sanitizeName(videoFile.name) : "通しテスト用の動画を選ぶ（任意・推奨）";
  });
  $("copyBtn").addEventListener("click", async () => {
    const text = $("report").textContent;
    try { await navigator.clipboard.writeText(text); $("copyBtn").textContent = "コピーしました"; }
    catch (e) { const r = document.createRange(); r.selectNodeContents($("report")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("copyBtn").textContent = "選択しました（Ctrl+C でコピー）"; }
    setTimeout(() => { $("copyBtn").textContent = "コピー"; }, 2500);
  });

  const errText = (e) => (e == null ? "不明" : typeof e === "number" ? "内部エラー(code " + e + ")" : String(e.message || e));
  const LABEL = { pass: "合格", fail: "不合格", warn: "注意" };

  /** 1項目分の行を作り、結果を確定する関数を返す。文字列は全て textContent で入れる */
  function row(name) {
    const li = document.createElement("li");
    li.className = "check-item";
    const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "…";
    const body = document.createElement("div"); body.textContent = name;
    li.append(tag, body);
    $("rows").appendChild(li);
    return (status, detail) => {
      li.className = "check-item " + status;
      tag.textContent = LABEL[status];
      if (detail) { const s = document.createElement("small"); s.textContent = detail; body.appendChild(s); }
      results.push(status);
      report.push(`[${status.toUpperCase()}] ${name}${detail ? " — " + detail : ""}`);
      $("report").textContent = report.join("\n");
    };
  }

  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const fig = (node, caption) => {
    const f = document.createElement("figure"); f.appendChild(node);
    const c = document.createElement("figcaption"); c.textContent = caption; f.appendChild(c); $("figs").appendChild(f);
  };

  async function run() {
    $("runBtn").disabled = true; $("rows").replaceChildren(); $("figs").replaceChildren(); $("verdict").hidden = true;
    report.length = 0; results.length = 0;
    report.push("FaceMosaic Browser 診断 " + new Date().toISOString(), "UA: " + navigator.userAgent, "URL: " + location.href);

    // 1. 実行環境
    let set = row("実行環境（https または localhost / Worker / OffscreenCanvas / WebCodecs / 暗号API）");
    const miss = [];
    if (location.protocol === "file:") miss.push("file:// では動きません（Web サーバー経由で開いてください）");
    else if (!window.isSecureContext) miss.push("https ではありません");
    if (typeof Worker === "undefined") miss.push("Worker");
    if (typeof OffscreenCanvas === "undefined") miss.push("OffscreenCanvas");
    if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") miss.push("WebCodecs（VideoEncoder/VideoDecoder）");
    if (!(window.crypto && crypto.subtle)) miss.push("Web Crypto");
    if (miss.length) { set("fail", "不足: " + miss.join(", ") + "。パソコンの最新の Chrome / Edge を https でお使いください。"); return finish(); }
    set("pass", location.protocol + " / " + navigator.userAgent.slice(0, 80));

    // 2. セキュリティ設定（CSP が実際に効いているか）
    set = row("セキュリティ設定（コンテンツ・セキュリティ・ポリシーが有効で、外部への通信が実際に遮断される）");
    try {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      if (!meta) throw new Error("CSP の meta タグがありません");
      const violated = new Promise((res) => {
        document.addEventListener("securitypolicyviolation", (e) => res(e.violatedDirective), { once: true });
        setTimeout(() => res(null), 2000);
      });
      try { await fetch("https://csp-test.invalid/probe", { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer" }); } catch (e) { /* 遮断されれば例外 */ }
      const dir = await violated;
      dir && String(dir).startsWith("connect-src") ? set("pass", "外部サイトへの接続を遮断（違反ディレクティブ: " + dir + "）") : set("fail", "外部への通信が遮断されませんでした。ブラウザまたは拡張機能が CSP を無効にしている可能性があります。");
    } catch (e) { set("fail", errText(e)); }

    // 3. ファイル配置と整合性
    let manifest = null;
    set = row("ファイルの整合性（integrity.json の SHA-256 と、配置された全ファイルが一致）");
    const manifestRes = await fetch("integrity.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))).catch((e) => { set("fail", "integrity.json を取得できません: " + errText(e)); return null; });
    manifest = manifestRes;
    if (manifest && manifest.files) {
      const bad = []; let total = 0;
      for (const [file, meta] of Object.entries(manifest.files)) {
        try {
          const r = await fetch(file, { cache: "no-cache" }); if (!r.ok) throw new Error("HTTP " + r.status);
          const buf = await r.arrayBuffer(); total++;
          if (buf.byteLength !== meta.size) bad.push(`${file}: サイズ ${buf.byteLength} ≠ ${meta.size}（アップロードが途中で切れていないか）`);
          else if ((await sha256Hex(buf)) !== meta.sha256) bad.push(`${file}: ハッシュ不一致（破損または改変）`);
        } catch (e) { bad.push(`${file}: ${errText(e)}${file.endsWith(".onnx") ? "  → README の手順でモデルを配置" : ""}`); }
      }
      bad.length ? set("fail", bad.join(" / ")) : set("pass", `${total} ファイルすべて一致`);
    } else if (!manifestRes) { /* 上で fail 済み */ } else set("fail", "integrity.json の形式が不正です");

    // 3b. モデル（固定ハッシュ）
    let modelBytes = null;
    set = row(`顔認識モデル ${C.MODEL_FILENAME}（固定の SHA-256 と一致）`);
    try {
      const r = await fetch("models/" + C.MODEL_FILENAME, { cache: "no-cache" }); if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = await r.arrayBuffer(); const h = await sha256Hex(buf);
      if (buf.byteLength === C.MODEL_SIZE && h === C.MODEL_SHA256) { modelBytes = buf; set("pass", h.slice(0, 16) + "…"); }
      else set("fail", `想定と一致しません（${buf.byteLength}バイト / ${h.slice(0, 16)}…）。正しいモデルを models/ に置いてください。`);
    } catch (e) { set("fail", errText(e) + "  → README の手順でモデルを配置してください"); }

    // 4. エンコード対応
    set = row("このブラウザの動画エンコード対応（1280×720）");
    try {
      const mb = await import("./vendor/mediabunny.min.js");
      const out = [];
      for (const c of ["avc", "hevc", "vp9", "av1"]) out.push(c + ":" + ((await mb.canEncodeVideo(c, { width: 1280, height: 720, bitrate: 2e6 })) ? "○" : "×"));
      const ok = out.some((s) => (s.startsWith("avc") || s.startsWith("vp9")) && s.endsWith("○"));
      ok ? set("pass", out.join("  ")) : set("fail", out.join("  ") + "  → H.264 も VP9 も使えません");
      if (out[0].endsWith("×")) row("H.264 で出力できない（標準画質の出力は VP9 になります）")("warn", "再生互換性のため、H.264 が使える Chrome / Edge を推奨");
    } catch (e) { set("fail", "Mediabunny を読み込めません: " + errText(e)); }

    // 5. エンジン起動
    set = row("顔認識エンジンの起動（OpenCV.js の読み込み + モデルの初期化と自己診断）");
    let worker = null;
    if (!modelBytes) { set("fail", "モデルが確認できていないためスキップ"); return finish(); }
    try {
      worker = new Worker("js/worker.js");
      const t0 = performance.now();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("120秒以内に起動しませんでした")), 120000);
        worker.onerror = (e) => { clearTimeout(timer); reject(new Error("Worker エラー: " + (e.message || "読み込み失敗"))); };
        worker.onmessage = (ev) => { const m = ev.data; if (m.type === "ready") { clearTimeout(timer); resolve(); } else if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); } };
        const copy = modelBytes.slice(0); worker.postMessage({ type: "init", modelBytes: copy }, [copy]);
      });
      set("pass", ((performance.now() - t0) / 1000).toFixed(1) + " 秒で起動");
    } catch (e) { set("fail", errText(e)); if (worker) worker.terminate(); return finish(); }

    // 6. 検出テスト
    set = row("顔検出テスト（内蔵の顔画像 → 検出 → 追跡確定 → モザイク）");
    try {
      const img = new Image(); img.src = "data:image/jpeg;base64," + FACE_B64; await img.decode();
      const c = new OffscreenCanvas(640, 480), g = c.getContext("2d");
      g.fillStyle = "#4a6a5a"; g.fillRect(0, 0, 640, 480); g.drawImage(img, 210, 130, 220, 220);
      const bitmap = await createImageBitmap(c);
      const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("タイムアウト")), 60000);
        worker.onmessage = (ev) => { const m = ev.data; if (m.type === "detected") { clearTimeout(timer); resolve(m); } else if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); } };
        worker.postMessage({ type: "detect-image", bitmap, id: 1 }, [bitmap]);
      });
      const ok = res.faces >= 1 && res.tracks >= 1 && res.changedPixels > 1500;
      ok ? set("pass", `顔 ${res.faces} 件を検出、モザイク ${res.changedPixels} 画素、位置 ${JSON.stringify(res.boxes)}`)
         : set("fail", `顔 ${res.faces} 件 / トラック ${res.tracks} / 変化 ${res.changedPixels} 画素。モデルまたは動作環境に問題がある可能性があります`);
      try {                                   // 画像の表示だけの失敗で、確定済みの検査結果を変えない
        const a = new Image(); a.alt = "入力"; a.src = URL.createObjectURL(await c.convertToBlob()); fig(a, "入力（診断用画像）");
        const b = new Image(); b.alt = "出力"; b.src = URL.createObjectURL(res.blob); fig(b, "出力（顔にモザイクが掛かっていればOK）");
      } catch (e) { /* 表示のみ */ }
    } catch (e) { set("fail", errText(e)); }

    // 7. 通しテスト（任意）
    set = row("通しテスト: 選んだ動画の先頭3秒を実際に変換（読み込み → 検出 → モザイク → エンコード → 音声 → 再生）");
    if (!videoFile) {
      set("warn", "動画が未選択のためスキップ。実際に使う動画（スマホの縦動画も含む）で一度確認することを強く推奨します");
    } else {
      try {
        const t0 = performance.now();
        const done = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("10分以内に完了しませんでした")), 600000);
          worker.onmessage = (ev) => { const m = ev.data; if (m.type === "done") { clearTimeout(timer); resolve(m); } else if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message)); } };
          worker.postMessage({ type: "export", file: videoFile, quality: "standard", accuracy: "high", maxSeconds: 3 });
        });
        const sec = (performance.now() - t0) / 1000, fps = done.frames / sec;
        const url = URL.createObjectURL(new Blob([done.buffer], { type: "video/mp4" }));
        const v = document.createElement("video"); v.controls = true; v.muted = true; v.playsInline = true; v.src = url;
        await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("出力動画をブラウザで再生できません（コーデック: " + done.codec + "）")); setTimeout(() => rej(new Error("出力動画のメタデータ取得がタイムアウト")), 10000); });
        fig(v, "出力（先頭3秒）。顔にモザイクが追従しているか、縦動画が縦のままか、音が出るか（ミュート解除）を確認してください");
        const warnTxt = (done.warnings || []).join(" / ");
        const ok = done.frames > 0 && v.duration > 0.5 && v.videoWidth > 0;
        ok ? set(warnTxt ? "warn" : "pass", `${done.frames} フレームを ${sec.toFixed(1)} 秒で処理（約 ${fps.toFixed(1)} フレーム/秒）、${v.videoWidth}×${v.videoHeight}、${v.duration.toFixed(1)} 秒、コーデック ${done.codec}、音声 ${done.hasAudio ? "あり" : "なし"}${warnTxt ? "、" + warnTxt : ""}`)
           : set("fail", "出力が不完全です（フレーム " + done.frames + "、長さ " + v.duration + "）");
        row("処理時間の目安（この端末・高精度）")("pass", `${fps.toFixed(1)} フレーム/秒 → 30fps の動画なら実時間の約 ${(30 / Math.max(fps, 0.1)).toFixed(1)} 倍（1分の動画で約 ${(30 * 60 / Math.max(fps, 0.1) / 60).toFixed(1)} 分）`);
      } catch (e) { set("fail", errText(e)); }
    }
    if (worker) worker.terminate();
    finish();
  }

  function finish() {
    const ng = results.filter((s) => s === "fail").length, wn = results.filter((s) => s === "warn").length;
    const v = $("verdict"); v.hidden = false;
    v.className = "verdict" + (ng ? " ng" : "");
    v.textContent = ng ? `不合格が ${ng} 件あります。上の「不合格」の項目を確認してください。` : `すべて合格です${wn ? "（注意 " + wn + " 件あり）" : ""}。アプリを利用できます。`;
    report.push("", "総合: " + (ng ? "不合格 " + ng + " 件" : "合格") + (wn ? "、注意 " + wn + " 件" : ""));
    $("report").textContent = report.join("\n");
    $("runBtn").disabled = false; $("runBtn").textContent = "もう一度診断する";
  }

  $("runBtn").addEventListener("click", () => run().catch((e) => { row("診断の実行")("fail", errText(e)); finish(); }));
})();
