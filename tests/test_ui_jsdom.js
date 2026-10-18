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
  const log = { sent: [], workers: [], intervals: [], clicks: [], terminated: 0, unloadPrevented: 0 };
  let clock = 0;
  const html = framed ? HTML.replace('<script>/* FaceMosaic Browser - app.js', '<script>FMCore.isFramed = () => true;</script><script>/* FaceMosaic Browser - app.js') : HTML;
  const dom = new JSDOM(html, { url: "https://fm.test/", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(w) {
    Object.defineProperty(w, "isSecureContext", { value: secure });
    w.URL.createObjectURL = () => "blob:fm/" + Math.random().toString(36).slice(2); w.URL.revokeObjectURL = () => {};
    w.OffscreenCanvas = function () {};
    if (!noWebCodecs) { w.VideoEncoder = function () {}; w.VideoDecoder = function () {}; }
    w.HTMLMediaElement.prototype.load = () => {};
    w.HTMLCanvasElement.prototype.getContext = function () { return { drawImage() {} }; };
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
        if (m.type === "preview") return setTimeout(() => this.emit({ type: "preview", id: m.id, blob: new w.Blob(["jpg"]), frames: 12 }), 40);
        if (m.type === "export") {
          this.canceled = false;
          if (m.file.name.includes("exportfail")) return this.emit({ type: "error", for: "export", message: "メモリ不足です" });
          if (m.file.name.includes("stall")) return this.emit({ type: "progress", value: 5, text: "処理中…" });   // 以後、何も返さない
          let v = 3; const tick = () => {
            if (this.canceled) return this.emit({ type: "canceled" });
            if (m.file.name.includes("crash") && v > 30) { return this.onerror && this.onerror({ message: "out of memory" }); }
            if (v >= 97) return this.emit({ type: "done", buffer: new ArrayBuffer(250000), codec: m.quality === "compact" ? "hevc" : "avc", frames: 375, size: 250000, ratioPct: m.quality === "compact" ? 38.5 : 71.2, warnings: m.file.name.includes("warn") ? ["音声トラックを出力に含められませんでした（undecodable_source_codec）。映像のみで出力します。"] : [], hasAudio: true });
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
