// 診断ページ(selfcheck.html)の検証: 各段階が最後まで走り、成功/失敗を正しく報告すること。
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const HTML = read("selfcheck.html")
  .replace('<script src="js/core.js"></script>', "<script>" + read("js/core.js") + "</script>")
  .replace('<script src="js/selfcheck.js"></script>', "<script>" + read("js/selfcheck.js") + "</script>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };
async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; }
const MANIFEST = JSON.parse(read("integrity.json"));
const MODEL_NAME = require("../js/core.js").C.MODEL_FILENAME;

function boot({ missing = [], tamper = null, truncate = null, workerFails = false, detectFaces = 1, noWebCodecs = false, cspEnforced = true, noManifest = false } = {}) {
  const dom = new JSDOM(HTML, { url: "https://fm.test/selfcheck.html", runScripts: "dangerously", pretendToBeVisual: true, beforeParse(w) {
    Object.defineProperty(w, "isSecureContext", { value: true });
    Object.defineProperty(w, "crypto", { value: { subtle: require("crypto").webcrypto.subtle }, configurable: true });
    if (!noWebCodecs) { w.VideoEncoder = function () {}; w.VideoDecoder = function () {}; }
    w.OffscreenCanvas = class { constructor(a, b) { this.width = a; this.height = b; } getContext() { return { fillRect() {}, drawImage() {}, fillStyle: "" }; } async convertToBlob() { return new w.Blob(["x"]); } };
    w.createImageBitmap = async () => ({ width: 640, height: 480 });
    w.Image = function () { const im = w.document.createElement("img"); im.decode = async () => {}; return im; };
    w.URL.createObjectURL = () => "blob:x";
    w.fetch = async (u) => {
      if (String(u).includes("csp-test.invalid")) { if (cspEnforced) { const e = new w.Event("securitypolicyviolation"); e.violatedDirective = "connect-src"; w.document.dispatchEvent(e); } throw new TypeError("blocked"); }
      const rel = String(u).replace(/^\.\//, "");
      if (rel === "integrity.json") { if (noManifest) return { ok: false, status: 404 }; const text = read("integrity.json"); return { ok: true, status: 200, json: async () => JSON.parse(text) }; }
      if (missing.includes(rel) || !fs.existsSync(path.join(ROOT, rel))) return { ok: false, status: 404 };
      let buf = fs.readFileSync(path.join(ROOT, rel));
      if (tamper === rel) { buf = Buffer.from(buf); buf[10] ^= 1; }
      if (truncate === rel) buf = buf.subarray(0, buf.length - 100);
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };
    w.Worker = class { constructor() {} postMessage(m) { setTimeout(() => {
      if (workerFails) return this.onmessage({ data: { type: "error", for: m.type, message: "YuNet モデルを読み込めませんでした: 100" } });
      if (m.type === "init") this.onmessage({ data: { type: m.modelBytes && m.modelBytes.byteLength ? "ready" : "error", message: "x" } });
      if (m.type === "detect-image") this.onmessage({ data: { type: "detected", id: m.id, faces: detectFaces, tracks: detectFaces, changedPixels: detectFaces ? 9000 : 0, boxes: [[200, 120, 420, 360]], blob: new w.Blob(["p"]) } });
    }, 10); } terminate() {} };
  } });
  const d = dom.window.document; const errors = []; dom.window.addEventListener("error", (e) => errors.push(e.message)); dom.window.addEventListener("unhandledrejection", (e) => errors.push("unhandled: " + e.reason));
  const rows = () => [...d.querySelectorAll("#rows .check-item")].map((li) => [li.querySelector(".tag").textContent, li.children[1].textContent, li.className]);
  return { w: dom.window, d, errors, rows, verdict: () => d.getElementById("verdict"), report: () => d.getElementById("report").textContent, run: () => d.getElementById("runBtn").click(),
    find: (needle) => rows().find((r) => r[1].includes(needle)) };
}

(async () => {
  let t = boot({ noWebCodecs: true }); t.run(); await until(() => !t.verdict().hidden);
  check("WebCodecs非対応: 環境チェックで不合格にして中断、対処を表示", t.rows()[0][0] === "不合格" && t.rows()[0][1].includes("Chrome") && t.rows().length === 1 && t.verdict().className.includes("ng"), JSON.stringify(t.rows()));

  t = boot({ missing: ["models/" + MODEL_NAME] }); t.run(); await until(() => !t.verdict().hidden);
  const m1 = t.find("顔認識モデル"), im = t.find("ファイルの整合性");
  check("モデル未配置: 整合性・モデルの両方が不合格で、README参照の案内、エンジン起動はスキップして終了", m1[0] === "不合格" && m1[1].includes("README") && im[0] === "不合格" && im[1].includes(".onnx") && t.rows().some((r) => r[1].includes("スキップ")) && t.verdict().className.includes("ng"), JSON.stringify([m1, im]));

  t = boot({ tamper: "vendor/opencv.js" }); t.run(); await until(() => !t.verdict().hidden);
  check("ライブラリが1バイト改変されていると、ハッシュ不一致として不合格(どのファイルかを表示)", t.find("ファイルの整合性")[0] === "不合格" && t.find("ファイルの整合性")[1].includes("vendor/opencv.js") && t.find("ファイルの整合性")[1].includes("ハッシュ不一致"));
  t = boot({ truncate: "js/worker.js" }); t.run(); await until(() => !t.verdict().hidden);
  check("アップロードが途中で切れた(サイズ不足)ファイルを、サイズの不一致として検出", t.find("ファイルの整合性")[0] === "不合格" && t.find("ファイルの整合性")[1].includes("js/worker.js") && t.find("ファイルの整合性")[1].includes("サイズ"));
  t = boot({ tamper: "models/" + MODEL_NAME }); t.run(); await until(() => !t.verdict().hidden);
  check("モデルが差し替えられると、固定ハッシュとの不一致で不合格にし、エンジンを起動しない", t.find("顔認識モデル")[0] === "不合格" && t.find("顔認識モデル")[1].includes("一致しません") && t.rows().some((r) => r[1].includes("スキップ")));
  t = boot({ noManifest: true }); t.run(); await until(() => !t.verdict().hidden);
  check("integrity.json が無い場合は不合格", t.find("ファイルの整合性")[0] === "不合格" && t.find("ファイルの整合性")[1].includes("integrity.json"));
  t = boot({ cspEnforced: false }); t.run(); await until(() => !t.verdict().hidden);
  check("CSP が実際には効いていない(外部通信が遮断されない)環境を不合格として検出", t.find("セキュリティ設定")[0] === "不合格" && t.find("セキュリティ設定")[1].includes("遮断されませんでした"));
  t = boot({ workerFails: true }); t.run(); await until(() => !t.verdict().hidden);
  check("エンジン起動失敗: 原因を表示して不合格", t.rows().some((r) => r[1].includes("顔認識エンジンの起動") && r[0] === "不合格" && r[1].includes("YuNet")) && t.verdict().className.includes("ng"));

  t = boot(); t.run(); await until(() => !t.verdict().hidden);
  const rows = t.rows();
  check("CSP が有効で、外部への通信が遮断されることを確認して合格", t.find("セキュリティ設定")[0] === "合格" && t.find("セキュリティ設定")[1].includes("connect-src"));
  check(`整合性: 台帳の全${Object.keys(MANIFEST.files).length}ファイルが一致して合格`, t.find("ファイルの整合性")[0] === "合格" && t.find("ファイルの整合性")[1].includes(`${Object.keys(MANIFEST.files).length} ファイル`), JSON.stringify(t.find("ファイルの整合性")));
  check("モデルが固定の SHA-256 と一致して合格", t.find("顔認識モデル")[0] === "合格");
  check("エンジン起動が合格(Workerのready)", rows.some((r) => r[1].includes("顔認識エンジンの起動") && r[0] === "合格"));
  check("顔検出テストが合格し、検出件数とモザイク画素数を表示", rows.some((r) => r[1].includes("顔検出テスト") && r[0] === "合格" && r[1].includes("9000")));
  check("通しテストは動画未選択なら『注意』でスキップ(失敗扱いにしない)", rows.some((r) => r[1].includes("通しテスト") && r[0] === "注意"));
  check("Mediabunnyを読めない環境(jsdom)ではエンコード対応を『不合格』として報告(例外で止まらない)", rows.some((r) => r[1].includes("エンコード対応") && r[0] === "不合格") && !t.verdict().hidden);
  check("コピー用レポートにUA・各項目・総合判定が入る", t.report().includes("UA:") && t.report().includes("[PASS]") && t.report().includes("総合:"), t.report().slice(0, 200));
  check("画面の表示はすべて textContent で入れられ、要素として解釈されない", t.d.querySelectorAll("#rows script, #rows img, #report *").length === 0);
  t = boot({ detectFaces: 0 }); t.run(); await until(() => !t.verdict().hidden);
  check("顔が検出できない場合は検出テストを不合格にする(誤合格しない)", t.rows().some((r) => r[1].includes("顔検出テスト") && r[0] === "不合格"));
  const tt = boot(); const btn = tt.d.getElementById("runBtn"); tt.run(); await until(() => !tt.verdict().hidden); tt.run(); await until(() => btn.disabled); await until(() => !btn.disabled);
  check("再実行しても結果が重複せず、ボタンが復帰する", tt.rows().filter((r) => r[1].includes("ファイルの整合性")).length === 1);
  check("診断ページで未処理の例外が発生していない", t.errors.length === 0 && tt.errors.length === 0, t.errors.concat(tt.errors).join(" | "));
  console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
