// 画面ロジック(app.js)の検証: jsdom + 偽Worker。実行: NODE_PATH=<jsdomのnode_modules> node tests/test_ui_jsdom.js
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const MODEL_SIZE = require("../js/core.js").C.MODEL_SIZE;
// CSP の script-src 'self' に合わせ、本番は外部ファイル。jsdom では同じ中身をインライン化して実行する
const HTML = read("index.html")
  .replace('<script src="js/core.js"></script>', "<script>" + read("js/core.js") + "</script>")
  .replace('<script src="js/app.js"></script>', "<script>" + read("js/app.js") + "</script>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(15); } return false; }

function boot({ modelStatus = 200, modelSize = MODEL_SIZE, noWebCodecs = false, secure = true, framed = false, framedThrows = false } = {}) {
  const log = { sent: [], workers: [], intervals: [], clicks: [], terminated: 0, unloadPrevented: 0, ctx: [] };
  let clock = 0;
  const html = framed ? HTML.replace('<script>/* FaceMosaic Browser - app.js', '<script>FMCore.isFramed = () => true;</script><script>/* FaceMosaic Browser - app.js') : HTML;
  const dom = new JSDOM(html, { url: "https://fm.test/", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(w) {
    Object.defineProperty(w, "isSecureContext", { value: secure });
    w.URL.createObjectURL = () => "blob:fm/" + Math.random().toString(36).slice(2); w.URL.revokeObjectURL = () => {};
    w.OffscreenCanvas = function () {};
    if (!noWebCodecs) { w.VideoEncoder = function () {}; w.VideoDecoder = function () {}; }
    w.HTMLMediaElement.prototype.load = () => {};
    const ctxProxy = new Proxy({}, { get(_, name) { return (...a) => { log.ctx.push([String(name), ...a]); }; }, set(_, k, v) { log.ctx.push(["set:" + String(k), v]); return true; } });
    w.HTMLCanvasElement.prototype.getContext = function () { return ctxProxy; };
    w.HTMLCanvasElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 }; };
    w.createImageBitmap = async () => ({ width: 640, height: 360, close() {} });
    w.HTMLAnchorElement.prototype.click = function () { log.clicks.push({ href: this.href, download: this.download, inDom: this.isConnected }); };
    w.fetch = async (u, o) => { log.fetchArgs = [u, o]; return modelStatus === 200 ? { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(modelSize) } : { ok: false, status: modelStatus }; };
    w.setInterval = (fn) => { log.intervals.push(fn); return log.intervals.length; };          // ウォッチドッグを手動で進める
    const realNow = w.Date.now; w.Date.now = () => realNow() + clock; log.advance = (ms) => { clock += ms; };
    w.Worker = class FakeWorker {
      constructor(url) { this.url = url; log.workers.push(this); this.canceled = false; }
      terminate() { log.terminated++; }
      emit(data) { setTimeout(() => this.onmessage && this.onmessage({ data }), 5); }
      postMessage(m) {
        if (m.type === "export" && m.file.name.includes("clonefail")) throw new Error("DataCloneError");
        log.sent.push(m);
        if (m.type === "init") return this.emit({ type: "ready" });
        if (m.type === "inspect") {
          const n = m.file.name;
          if (n.includes("broken")) return this.emit({ type: "error", for: "inspect", id: m.id, message: "この形式の動画は読み込めません" });
          if (n.includes("hang")) return;                                    // 応答しない
          return this.emit({ type: "inspected", id: m.id, info: { width: 1280, height: 720, duration: 12.5, codec: n.includes("hevc") ? "hevc" : "avc", hasAudio: !n.includes("silent"), decodable: !n.includes("nodecode") } });
        }
        if (m.type === "preview") return setTimeout(() => this.emit({ type: "preview", id: m.id, blob: new w.Blob(["jpg"]), frames: 12, frameTime: Math.max(0, m.time - 0.0123) }), 40);
        if (m.type === "export") {
          this.canceled = false;
          if (m.file.name.includes("exportfail")) return this.emit({ type: "error", for: "export", message: "メモリ不足です" });
          if (m.file.name.includes("stall")) return this.emit({ type: "progress", value: 5, text: "処理中…" });   // 以後、何も返さない
          let v = 3; const tick = () => {
            if (this.canceled) return this.emit({ type: "canceled" });
            if (m.file.name.includes("crash") && v > 30) { return this.onerror && this.onerror({ message: "out of memory" }); }
            if (v >= 97) return this.emit({ type: "done", buffer: new ArrayBuffer(250000), codec: m.quality === "compact" ? "hevc" : "avc", frames: 375, size: 250000, ratioPct: m.quality === "compact" ? 38.5 : 71.2, manualCount: (m.regions || []).length, warnings: m.file.name.includes("warn") ? ["音声トラックを出力に含められませんでした（undecodable_source_codec）。映像のみで出力します。"] : [], hasAudio: true });
            this.emit({ type: "progress", value: v, text: `顔検出・モザイク処理中… ${Math.round(v * 3.9)}フレーム処理済み / 残り約2分` }); v += 17; setTimeout(tick, 60);
          }; tick(); return;
        }
        if (m.type === "cancel") this.canceled = true;
      }
    };
  } });
  const w = dom.window, d = w.document, $ = (id) => d.getElementById(id);
  w.addEventListener("beforeunload", (e) => { if (e.defaultPrevented) log.unloadPrevented++; });
  const mkFile = (name, size) => { const f = new w.File(["x"], name, { type: "video/mp4" }); if (size) Object.defineProperty(f, "size", { value: size }); return f; };
  const pick = (f) => { Object.defineProperty($("fileInput"), "files", { value: [f], configurable: true }); $("fileInput").dispatchEvent(new w.Event("change")); };
  const errors = []; w.addEventListener("error", (e) => errors.push(e.message));
  return { w, d, $, log, mkFile, pick, errors, sent: (t) => log.sent.filter((m) => m.type === t), watchdog: () => log.intervals.forEach((f) => f()) };
}
const banner = (t) => t.$("banner");

(async () => {
  // ================= セキュリティ: フレーム埋め込み =================
  let t = boot({ framed: true }); await sleep(60);
  check("iframe に埋め込まれた場合は、案内だけを表示してアプリを起動しない(Worker も作らない)", !!t.d.querySelector(".frame-blocked") && !t.d.getElementById("app") && t.log.workers.length === 0 && !t.d.documentElement.classList.contains("fm-ok"), t.d.body.textContent.slice(0, 80));
  const FMc = require("../js/core.js");
  check("isFramed: top と self が同じなら false / 違えば true / top へのアクセスが例外(クロスオリジン)なら true",
    FMc.isFramed({ top: 1, self: 1 }) === false && FMc.isFramed({ top: {}, self: {} }) === true && FMc.isFramed({ get top() { throw new Error("SecurityError"); }, self: {} }) === true);
  t = boot(); await until(() => !t.$("drop").classList.contains("disabled"));
  check("通常表示では fm-ok が付き、起動中メッセージが消える", t.d.documentElement.classList.contains("fm-ok") && !t.d.getElementById("boot"));

  // ================= 動作環境 =================
  t = boot({ noWebCodecs: true }); await until(() => !banner(t).hidden);
  check("WebCodecs 非対応ブラウザは理由と対処(Chrome/Edge)を表示し、操作不可", banner(t).textContent.includes("WebCodecs") && t.$("fileInput").disabled && t.log.workers.length === 0 && banner(t).classList.contains("error"), banner(t).textContent);
  t = boot({ secure: false }); await until(() => !banner(t).hidden);
  check("非 https は案内を表示", banner(t).textContent.includes("https") && t.$("fileInput").disabled);

  // ================= モデル =================
  t = boot({ modelStatus: 404 }); await until(() => !t.$("modelPick").hidden);
  check("モデル未配置: 案内(ファイル名)とモデル選択ボタンを表示し、動画選択は不可", banner(t).textContent.includes("face_detection_yunet_2026may.onnx") && t.$("fileInput").disabled && !t.$("modelPick").hidden && t.$("engineState").textContent.includes("見つかりません") && t.$("engineState").classList.contains("error"));
  const pickModel = (size) => { const f = new t.w.File([new Uint8Array(size)], "m.onnx"); Object.defineProperty(t.$("modelInput"), "files", { value: [f], configurable: true }); t.$("modelInput").dispatchEvent(new t.w.Event("change")); };
  pickModel(50); await until(() => banner(t).textContent.includes("一致しません"));
  check("サイズが違うモデルは拒否してエンジンへ渡さない", banner(t).textContent.includes("一致しません") && t.sent("init").length === 0);
  pickModel(MODEL_SIZE); await until(() => !t.$("fileInput").disabled);
  check("正しいサイズのモデルを手動指定すると準備完了(最終的なハッシュ確認は Worker)", !t.$("fileInput").disabled && t.$("modelPick").hidden && t.sent("init").length === 1);
  t = boot({ modelSize: 1234 }); await until(() => !t.$("modelPick").hidden);
  check("サーバー上のモデルのサイズが違う(差し替え/破損)場合も、準備完了にしない", t.sent("init").length === 0 && banner(t).textContent.includes("一致しません"));

  // ================= 正常系 =================
  t = boot(); await until(() => !t.$("fileInput").disabled);
  check("起動: 準備完了で動画選択が可能。モデル取得は資格情報・リファラ無し", !t.$("fileInput").disabled && t.$("exportBtn").disabled && t.$("engineState").textContent === "利用可能" && t.sent("init")[0].modelBytes.byteLength === MODEL_SIZE && t.log.fetchArgs[0] === "models/face_detection_yunet_2026may.onnx" && t.log.fetchArgs[1].credentials === "omit" && t.log.fetchArgs[1].referrerPolicy === "no-referrer", JSON.stringify(t.log.fetchArgs));
  check("Worker は js/worker.js を使用", t.log.workers[0].url === "js/worker.js");

  t.pick(t.mkFile("山行記録.mp4"));
  await until(() => !t.$("previewCanvas").hidden);
  check("動画選択: 解析→情報表示→プレビュー(canvas)表示、案内文は非表示", t.$("fileMeta").textContent.includes("山行記録.mp4") && t.$("fileMeta").textContent.includes("1280×720") && t.$("fileMeta").textContent.includes("00:12") && !t.$("timeline").hidden && !t.$("exportBtn").disabled && t.$("empty").hidden && t.$("drop").hidden && !t.$("changeBtn").hidden, t.$("fileMeta").textContent);
  check("プレビューのcanvasを画像サイズに合わせる(640x360)", t.$("previewCanvas").width === 640 && t.$("previewCanvas").height === 360);
  check("最初のプレビューは t=0・検出精度=high で要求", t.sent("preview")[0].time === 0 && t.sent("preview")[0].accuracy === "high" && t.sent("preview")[0].file.name === "山行記録.mp4");
  check("スライダー最大値=動画長", t.$("slider").max === "12.5");

  const before = t.sent("preview").length;
  for (let i = 1; i <= 20; i++) { t.$("slider").value = String(i * 0.5); t.$("slider").dispatchEvent(new t.w.Event("input")); await sleep(8); }
  await sleep(500);
  const reqs = t.sent("preview").slice(before);
  check(`スライダー連打(20回)でもプレビュー要求は間引かれる(${reqs.length}件)`, reqs.length >= 1 && reqs.length <= 4, reqs.length);
  check("連打後、最終位置(10秒)のプレビューが要求される", reqs[reqs.length - 1].time === 10, reqs.map((r) => r.time).join());
  check("時刻ラベルが最終位置を表示", t.$("timeLabel").textContent.startsWith("00:10"), t.$("timeLabel").textContent);

  const b2 = t.sent("preview").length; t.$("accuracy").value = "fast"; t.$("accuracy").dispatchEvent(new t.w.Event("change")); await sleep(120);
  check("検出精度を変えるとプレビューを更新(accuracy=fast を送る)", t.sent("preview").length > b2 && t.sent("preview").at(-1).accuracy === "fast");

  // 出力（標準）
  t.$("exportBtn").click(); t.$("exportBtn").dispatchEvent(new t.w.MouseEvent("click", { bubbles: true }));   // ボタンの無効化を迂回した2回目も、ガードで無視される
  check("出力開始: 設定・スライダー・再選択が無効、中断が有効、進捗表示", t.$("quality").disabled && t.$("accuracy").disabled && t.$("slider").disabled && t.$("changeBtn").disabled && !t.$("cancelBtn").disabled && !t.$("progress").hidden);
  check("二重クリックでも export は1回だけ送信。品質・精度を渡す", t.sent("export").length === 1 && t.sent("export")[0].quality === "standard" && t.sent("export")[0].accuracy === "fast");
  await until(() => parseInt(t.$("progPct").textContent) > 0);
  check("進捗と残り時間が表示される", t.$("progText").textContent.includes("フレーム処理済み") && t.$("progText").textContent.includes("残り約"));
  await until(() => !t.$("result").hidden);
  check("完了: 結果表示・動画src・サイズ表示", t.$("downloadBtn").textContent.includes("244") && t.$("resultVideo").getAttribute("src").startsWith("blob:") && t.$("resultSummary").textContent.includes("71.2%") && t.$("resultSummary").textContent.includes("H.264"), t.$("downloadBtn").textContent);
  check("完了後はUIが再び操作可能", !t.$("quality").disabled && t.$("cancelBtn").disabled && !t.$("exportBtn").disabled);
  t.$("downloadBtn").click();
  const dl = t.log.clicks.at(-1);
  check("ダウンロード: 一時リンクを作ってクリックし、DOMに残さない。名前は <元の名前>_mosaic.mp4", dl && dl.download === "山行記録_mosaic.mp4" && dl.href.startsWith("blob:") && !t.d.querySelector("a[download]"), JSON.stringify(dl));

  // 出力（軽量）
  t.$("quality").value = "compact"; t.$("exportBtn").click();
  check("軽量モードは quality=compact で送信し、前回の結果を消す", t.sent("export")[1].quality === "compact" && t.$("result").hidden);
  await until(() => !t.$("result").hidden);
  t.$("downloadBtn").click();
  check("軽量: 名前に _0.4x、HEVC の注意表示", t.log.clicks.at(-1).download === "山行記録_mosaic_0.4x.mp4" && t.$("resultSummary").textContent.includes("HEVC") && t.$("resultSummary").textContent.includes("再生できません"));

  // 中断
  t.$("exportBtn").click(); await until(() => parseInt(t.$("progPct").textContent) > 0);
  t.$("cancelBtn").click();
  await until(() => banner(t).textContent.includes("中断"));
  check("中断: 通知され、再度出力できる状態に戻る", t.$("progress").hidden && !t.$("exportBtn").disabled && !t.$("quality").disabled && t.sent("cancel").length === 1 && !banner(t).classList.contains("error"));

  // ================= 入力の検査 =================
  t.pick(t.mkFile("旅行.avi")); await sleep(80);
  check("未対応形式(.avi)は解析せずに案内", banner(t).textContent.includes("未対応") && t.sent("inspect").length === 1);
  t.pick(t.mkFile("empty.mp4", -1)); await sleep(30);
  t.pick(t.mkFile("broken.mp4")); await until(() => banner(t).textContent.includes("読み込めません"));
  check("読み込めない動画: エラー表示して初期状態に戻る", banner(t).textContent.includes("読み込めません") && t.$("timeline").hidden && !t.$("drop").hidden, banner(t).textContent);
  t.pick(t.mkFile("nodecode.mp4")); await until(() => banner(t).textContent.includes("コーデック"));
  check("デコード不可: コーデック名と対処(mp4へ変換)を表示", banner(t).textContent.includes("avc") && banner(t).textContent.includes("変換") && t.$("timeline").hidden);
  t.pick(t.mkFile("huge.mp4", 1.2 * 1024 ** 3)); await until(() => !t.$("timeline").hidden);
  check("1GB超は警告(注意色)を出しつつ処理は継続可能", !t.$("timeline").hidden);
  t.pick(t.mkFile("giant.mp4", 5 * 1024 ** 3)); await sleep(60);
  check("4GB超は受け付けない(エラー色)", banner(t).textContent.includes("大きすぎ") && banner(t).classList.contains("error"));

  // ================= セキュリティ: 悪意あるファイル名 =================
  t.pick(t.mkFile('<img src=x onerror="alert(1)"><script>alert(2)</script>.mp4')); await until(() => !t.$("timeline").hidden);
  check("ファイル名にHTML/スクリプトがあっても、要素を作らず文字として表示(XSS対策)", !t.d.querySelector("img[src='x']") && !t.d.querySelector("#fileMeta img, #fileMeta script") && t.$("fileMeta").textContent.includes("<img") === false && t.$("fileMeta").children.length === 0, t.$("fileMeta").innerHTML);
  t.$("exportBtn").click(); await until(() => !t.$("result").hidden); t.$("downloadBtn").click();
  const evil = t.log.clicks.at(-1).download;
  check("ダウンロード名から記号(<>\"/\\:*?|)が除かれる", !/[<>"\/\\:*?|]/.test(evil) && /_mosaic(_0\.4x)?\.mp4$/.test(evil), evil);
  t.pick(t.mkFile("photo\u202Etxt.4pm")); await until(() => !t.$("timeline").hidden); t.$("exportBtn").click(); await until(() => !t.$("result").hidden); t.$("downloadBtn").click();
  const rlo = t.log.clicks.at(-1).download;
  check("向きを反転させる文字(RLO等)が除かれ、拡張子の偽装表示ができない", !/[\u202a-\u202e\u2066-\u2069]/.test(rlo) && /_mosaic(_0\.4x)?\.mp4$/.test(rlo), JSON.stringify(rlo));
  t.pick(t.mkFile("../../etc/passwd.mp4")); await until(() => !t.$("timeline").hidden); t.$("exportBtn").click(); await until(() => !t.$("result").hidden); t.$("downloadBtn").click();
  const trav = t.log.clicks.at(-1).download;
  check("パス区切りを含む名前でも、ダウンロード名にパスが入らない", !trav.includes("/") && !trav.includes("\\") && !trav.startsWith("."), trav);
  t.pick(t.mkFile("CON.mp4")); await until(() => !t.$("timeline").hidden); t.$("exportBtn").click(); await until(() => !t.$("result").hidden); t.$("downloadBtn").click();
  check("Windows の予約名(CON)を避ける", /^_CON_mosaic(_0\.4x)?\.mp4$/.test(t.log.clicks.at(-1).download), t.log.clicks.at(-1).download);

  // ================= 異常系 =================
  t.pick(t.mkFile("exportfail.mp4")); await until(() => !t.$("exportBtn").disabled);
  t.$("exportBtn").click(); await until(() => banner(t).textContent.includes("メモリ不足"));
  check("出力失敗: Worker のエラー文を表示し、再試行可能", banner(t).textContent.includes("処理に失敗") && t.$("progress").hidden && !t.$("exportBtn").disabled);
  t.pick(t.mkFile("clonefail.mp4")); await until(() => !t.$("exportBtn").disabled);
  t.$("exportBtn").click(); await sleep(60);
  check("Worker へのデータ送信が失敗(DataCloneError)しても、画面がロックされず原因を表示", banner(t).textContent.includes("送信に失敗") && !t.$("exportBtn").disabled && t.$("progress").hidden, banner(t).textContent);
  t.pick(t.mkFile("warn.mp4")); await until(() => !t.$("exportBtn").disabled);
  t.$("exportBtn").click(); await until(() => !t.$("result").hidden);
  check("警告付き完了: 音声欠落の警告を結果に表示", !t.$("resultWarn").hidden && t.$("resultWarn").textContent.includes("音声"));

  // 保存領域・Cookie は使わない
  check("localStorage・sessionStorage・Cookie を使っていない(動画に関する情報を端末に残さない)", t.w.localStorage.length === 0 && t.w.sessionStorage.length === 0 && t.d.cookie === "");
  check("処理中に画面を離れようとすると確認が出る(beforeunload)", await (async () => { t.pick(t.mkFile("a.mp4")); await until(() => !t.$("exportBtn").disabled); t.$("exportBtn").click(); const ev = new t.w.Event("beforeunload", { cancelable: true }); t.w.dispatchEvent(ev); return ev.defaultPrevented; })());
  await until(() => !t.$("result").hidden);


  // ================= 手動モザイク（範囲指定） =================
  t = boot(); await until(() => !t.$("fileInput").disabled);
  const cv_ = () => t.$("previewCanvas");
  const ptr = (type, x, y, extra = {}) => { const ev = new t.w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...extra }); Object.defineProperty(ev, "pointerId", { value: 1 }); cv_().dispatchEvent(ev); return ev; };
  const drag = (x0, y0, x1, y1) => { ptr("pointerdown", x0, y0); ptr("pointermove", (x0 + x1) / 2, (y0 + y1) / 2); ptr("pointerup", x1, y1); };
  const items = () => [...t.d.querySelectorAll("#regionList .region-item")];
  const lastPreview = () => t.sent("preview").at(-1);
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

  ptr("pointerdown", 10, 10); ptr("pointerup", 200, 200);
  check("動画を選ぶ前は、ドラッグしても範囲は作られない", items().length === 0 && t.$("regionEmpty").hidden === false && t.$("clearRegionsBtn").disabled);
  t.pick(t.mkFile("manual.mp4")); await until(() => !t.$("previewCanvas").hidden);
  check("初期状態: 範囲なし・『範囲はまだありません』・すべて削除は無効。最初のプレビューは regions=[] を送る", items().length === 0 && !t.$("regionEmpty").hidden && t.$("clearRegionsBtn").disabled && Array.isArray(t.sent("preview")[0].regions) && t.sent("preview")[0].regions.length === 0);

  // 6秒の位置へ移動してからドラッグ
  t.$("slider").value = "6"; t.$("slider").dispatchEvent(new t.w.Event("input")); await sleep(300);
  check("プレビューのフレーム時刻(frameTime)を受け取って保持する(要求6秒 → 表示は 5.9877秒)", near(lastPreview().time, 6));
  drag(64, 36, 192, 144);
  check("プレビュー上のドラッグで範囲が1件でき、一覧に表示される", items().length === 1 && !t.$("regionEmpty").hidden === false && !t.$("clearRegionsBtn").disabled, items().length);
  await sleep(300);
  let reg = lastPreview().regions;
  check("範囲は『画面に対する割合』で保存され(x=0.1,y=0.1,w=0.2,h=0.3)、開始は表示中フレームの時刻(5.9877)、終了は null(最後まで)", reg.length === 1 && near(reg[0].x, 0.1) && near(reg[0].y, 0.1) && near(reg[0].w, 0.2) && near(reg[0].h, 0.3) && near(reg[0].start, 5.9877, 1e-9) && reg[0].end === null, JSON.stringify(reg));
  check("範囲を作ると、プレビューが再要求される(モザイクを反映した画像を見られる)", lastPreview().regions.length === 1);
  const strokes = () => t.log.ctx.filter((c) => c[0] === "strokeRect");
  t.log.ctx.length = 0; t.$("slider").dispatchEvent(new t.w.Event("input")); await sleep(300);
  check("プレビュー上に、有効な範囲の枠(点線)を重ねて描く", strokes().some((c) => near(c[1], 64) && near(c[2], 36) && near(c[3], 128) && near(c[4], 108)) && t.log.ctx.some((c) => c[0] === "setLineDash"), JSON.stringify(strokes()));
  check("範囲の項目は、数値入力と固定の文言だけで作られる(HTML文字列を使わない)", items()[0].querySelectorAll("input[type=number]").length === 2 && !items()[0].innerHTML.includes("<script") && items()[0].querySelector(".region-summary").textContent.includes("最後まで"), items()[0].textContent);

  // ドラッグの境界
  const nBefore = items().length;
  ptr("pointerdown", 300, 200); ptr("pointerup", 301, 201);
  check("クリックだけ・数ピクセルのドラッグは範囲にならない", items().length === nBefore);
  drag(300, 200, 300, 330);
  check("幅が0の(縦線のような)ドラッグは範囲にならない", items().length === nBefore);
  ptr("pointerdown", 100, 100, { button: 2 }); ptr("pointerup", 300, 300, { button: 2 });
  check("右クリックでは範囲を作らない", items().length === nBefore);
  drag(300, 200, 307, 300);
  check("幅が約7px(8px未満)の細いドラッグは範囲にならない", items().length === nBefore);
  drag(300, 200, 400, 206);
  check("高さが約6px(8px未満)の低いドラッグも範囲にならない", items().length === nBefore);
  ptr("pointerdown", 500, 250); ptr("pointermove", 900, 700); await sleep(80);
  { const k = t.log.ctx.map((c, i) => (c[0] === "set:strokeStyle" && c[1] === "#ffffff" ? i : -1)).filter((i) => i >= 0).pop();
    const sr = k === undefined ? null : t.log.ctx.slice(k).find((c) => c[0] === "strokeRect");
    check("ドラッグ中の枠(白)は、枠の外へ引いても画面の内側に収まって描かれる", sr && sr[1] >= 0 && sr[2] >= 0 && sr[1] + sr[3] <= 640 + 1e-6 && sr[2] + sr[4] <= 360 + 1e-6, JSON.stringify(sr)); }
  ptr("pointerup", 900, 700);
  await sleep(300);
  const rg = lastPreview().regions.at(-1);
  check("枠の外までドラッグしても、画面の内側(0〜1)に収まる", items().length === nBefore + 1 && near(rg.x, 500 / 640) && near(rg.y, 250 / 360) && near(rg.x + rg.w, 1) && near(rg.y + rg.h, 1), JSON.stringify(rg));
  drag(400, 300, 100, 50);
  await sleep(300);
  const rg2 = lastPreview().regions.at(-1);
  check("右下から左上へのドラッグでも、正しい範囲(x,yは小さい側)になる", near(rg2.x, 100 / 640) && near(rg2.y, 50 / 360) && near(rg2.w, 300 / 640) && near(rg2.h, 250 / 360), JSON.stringify(rg2));

  // 継続秒数・開始の編集
  const inputsOf = (i) => items()[i].querySelectorAll("input[type=number]");
  const setVal = (input, v) => { input.value = v; input.dispatchEvent(new t.w.Event("change")); };
  setVal(inputsOf(0)[1], "3"); await sleep(300);
  reg = lastPreview().regions[0];
  check("継続(秒)=3 を指定すると、終了=開始+3 になる(『解除』の指定)", near(reg.end, reg.start + 3, 1e-9) && items()[0].querySelector(".region-summary").textContent.includes("3.0秒間"), JSON.stringify(reg) + items()[0].querySelector(".region-summary").textContent);
  setVal(inputsOf(0)[1], ""); await sleep(300);
  check("継続を空にすると『最後まで』に戻る", lastPreview().regions[0].end === null && items()[0].querySelector(".region-summary").textContent.includes("最後まで"));
  setVal(inputsOf(0)[1], "abc"); await sleep(200); check("数値でない継続は『最後まで』として扱う(エラーにしない)", lastPreview().regions[0].end === null);
  setVal(inputsOf(0)[1], "0"); await sleep(200); check("継続は最小0.1秒に補正する(0秒や負の値で、無効な範囲を作らない)", near(lastPreview().regions[0].end - lastPreview().regions[0].start, 0.1, 1e-9));
  setVal(inputsOf(0)[1], "-5"); await sleep(200); check("負の継続も0.1秒に補正", near(lastPreview().regions[0].end - lastPreview().regions[0].start, 0.1, 1e-9));
  setVal(inputsOf(0)[1], "2.5"); setVal(inputsOf(0)[0], "8"); await sleep(300);
  reg = lastPreview().regions[0];
  check("開始を 8秒 に変更すると、継続(2.5秒)を保ったまま 8〜10.5秒 になる", near(reg.start, 8) && near(reg.end, 10.5), JSON.stringify(reg));
  setVal(inputsOf(0)[0], "999"); await sleep(200);
  check("開始が動画の長さ(12.5秒)を超える値は、末尾の手前に補正する", lastPreview().regions[0].start <= 12.49 && lastPreview().regions[0].start >= 12.4, lastPreview().regions[0].start);
  setVal(inputsOf(0)[0], "-3"); await sleep(200);
  check("開始が負の値は 0 に補正", lastPreview().regions[0].start === 0);
  setVal(inputsOf(0)[0], "xyz"); await sleep(200);
  check("開始が数値でない場合は、元の値のまま(壊れた値を送らない)", Number.isFinite(lastPreview().regions[0].start));

  // 枠が有効な時刻だけ描かれる
  setVal(inputsOf(0)[0], "10"); setVal(inputsOf(0)[1], "1"); await sleep(300);
  t.$("slider").value = "2"; t.log.ctx.length = 0; t.$("slider").dispatchEvent(new t.w.Event("input")); await sleep(350);
  const firstStroke = (c) => strokes().filter((s) => near(s[1], 64) && near(s[2], 36));
  check("範囲が有効でない時刻(開始前)のプレビューには、その範囲の枠を描かない", firstStroke().length === 0, JSON.stringify(strokes()));

  // 移動ボタン・最後までボタン
  items()[0].querySelectorAll("button")[0].click(); await sleep(100);
  check("『この時刻へ移動』で、スライダーが範囲の開始時刻に移る", near(parseFloat(t.$("slider").value), 10) && t.$("timeLabel").textContent.startsWith("00:10"), t.$("slider").value);
  setVal(inputsOf(0)[1], "1"); items()[0].querySelectorAll("button")[1].click(); await sleep(300);
  check("『最後まで』ボタンで継続が空になり、終了が null に戻る", inputsOf(0)[1].value === "" && lastPreview().regions[0].end === null);

  // 削除
  const n0 = items().length; items()[1].querySelectorAll("button")[2].click(); await sleep(300);
  check("『削除』で、その範囲だけが消え、プレビューに反映される", items().length === n0 - 1 && lastPreview().regions.length === n0 - 1 && items().map((li) => li.querySelector("strong").textContent).join() === Array.from({ length: n0 - 1 }, (_, i) => `範囲 ${i + 1}`).join());
  t.w.confirm = () => false; t.$("clearRegionsBtn").click(); check("『すべて削除』で確認を断ると、何も消えない", items().length === n0 - 1);
  t.w.confirm = () => true;

  // 書き出し
  t.$("exportBtn").click(); await sleep(30);
  const ex = t.sent("export").at(-1);
  check("書き出しの指示に、手動範囲(検証済みの割合・開始・終了)が含まれる", ex.regions.length === n0 - 1 && ex.regions.every((r) => r.x >= 0 && r.x + r.w <= 1.0000001 && r.y + r.h <= 1.0000001 && Number.isFinite(r.start)), JSON.stringify(ex.regions[0]));
  check("処理中: 範囲の入力欄・ボタン・すべて削除が無効、ドラッグでも範囲は増えない", [...t.d.querySelectorAll("#regionList input, #regionList button")].every((x) => x.disabled) && t.$("clearRegionsBtn").disabled && (() => { const c = items().length; drag(20, 20, 200, 200); return items().length === c; })());
  await until(() => !t.$("result").hidden);
  check("完了の概要に、手動モザイクの件数を表示", t.$("resultSummary").textContent.includes(`手動モザイク${n0 - 1}件`), t.$("resultSummary").textContent);
  check("完了後は範囲の編集が再び可能", [...t.d.querySelectorAll("#regionList input, #regionList button")].every((x) => !x.disabled) && !t.$("clearRegionsBtn").disabled);
  t.$("clearRegionsBtn").click(); await sleep(300);
  check("『すべて削除』(確認OK)で全て消え、プレビューは regions=[] で再要求される", items().length === 0 && !t.$("regionEmpty").hidden && lastPreview().regions.length === 0 && t.$("clearRegionsBtn").disabled);

  // 上限・新しい動画での初期化
  for (let i = 0; i < 100; i++) drag(10 + (i % 10) * 5, 10, 60 + (i % 10) * 5, 80);
  check("範囲は100件まで作れる", items().length === 100, items().length);
  drag(100, 100, 300, 300);
  check("101件目は作らず、上限を案内する", items().length === 100 && banner(t).textContent.includes("最大100件"), banner(t).textContent);
  await sleep(300);
  check("100件でも、プレビュー・書き出しの指示は検証を通る(上限ちょうどは有効)", lastPreview().regions.length === 100);
  t.pick(t.mkFile("another.mp4")); await until(() => !t.$("timeline").hidden && !t.$("previewCanvas").hidden); await sleep(200);
  check("別の動画を選ぶと、前の動画の手動範囲は消える(別の動画に誤って掛けない)", items().length === 0 && t.sent("preview").at(-1).regions.length === 0 && !t.$("regionEmpty").hidden);
  check("手動モザイクの操作で、JavaScriptエラーは発生しない", t.errors.length === 0, t.errors.join(" | "));

  // ================= ウォッチドッグ（処理が止まった場合） =================
  t = boot(); await until(() => !t.$("fileInput").disabled);
  t.pick(t.mkFile("stall.mp4")); await until(() => !t.$("exportBtn").disabled);
  t.$("exportBtn").click(); await until(() => parseInt(t.$("progPct").textContent) >= 5);
  t.watchdog(); check("進捗が出ている間は、停止とみなさない", banner(t).hidden && t.log.terminated === 0);
  t.log.advance(121000); t.watchdog();
  check("2分以上進捗が無いと停止と判断: Worker を終了し、原因の見当と再読み込みを案内、UIはロックされない", banner(t).textContent.includes("進みませんでした") && t.log.terminated === 1 && t.$("progress").hidden && t.$("engineState").textContent.includes("再読み込み") && t.$("fileInput").disabled, banner(t).textContent);

  // ================= 応答しない解析・Worker 異常停止 =================
  t = boot(); await until(() => !t.$("fileInput").disabled);
  t.pick(t.mkFile("crash.mp4")); await until(() => !t.$("exportBtn").disabled);
  t.$("exportBtn").click(); await until(() => banner(t).textContent.includes("停止"), 5000);
  check("処理中にWorkerが異常停止: 原因の見当と再読み込みを案内し、Workerを終了", banner(t).textContent.includes("メモリ不足") && t.$("progress").hidden && t.$("engineState").textContent.includes("再読み込み") && t.log.terminated === 1, banner(t).textContent);

  // ================= 予期しないエラー =================
  t = boot(); await until(() => !t.$("fileInput").disabled);
  t.w.dispatchEvent(new t.w.ErrorEvent("error", { message: "boom <b>x</b>" })); await sleep(10);
  check("予期しない例外: 画面に原因を表示(HTMLとして解釈しない)", banner(t).textContent.includes("予期しないエラー") && banner(t).textContent.includes("<b>x</b>") && banner(t).children.length === 0 && banner(t).classList.contains("error"));
  t.w.dispatchEvent(new t.w.ErrorEvent("error", { message: "second" })); await sleep(10);
  check("既にエラーが表示されていれば、後続の予期しない例外で原因表示を上書きしない", banner(t).textContent.includes("boom"));

  check("ページ内でJavaScriptエラーが発生していない(テストで注入したものを除く)", t.errors.length === 2, t.errors.join(" | "));
  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
