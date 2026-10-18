// セキュリティ設定の静的検査。GitHub Actions を使わない代わりに、公開前に手元で `npm test` で実行する。
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };

const JS = ["js/core.js", "js/pipeline.js", "js/worker.js", "js/app.js", "js/selfcheck.js"];
const HTML = ["index.html", "selfcheck.html"];
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/.*$/gm, "$1");

// ---------- CSP ----------
const cspOf = (html) => { const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/); return m ? m[1] : null; };
const parseCsp = (s) => Object.fromEntries(s.split(";").map((x) => x.trim()).filter(Boolean).map((x) => { const [d, ...v] = x.split(/\s+/); return [d, v]; }));
const csps = HTML.map((f) => cspOf(read(f)));
check("全ページに CSP(meta) がある", csps.every(Boolean), JSON.stringify(csps));
const P = csps.map((c) => (c ? parseCsp(c) : {}));
for (const [i, f] of HTML.entries()) {
  const p = P[i], eq = (d, v) => p[d] && p[d].join(" ") === v;
  check(`${f}: default-src 'none'・script-src 'self'・style-src 'self'・connect-src 'self'・worker-src 'self'`, eq("default-src", "'none'") && eq("script-src", "'self'") && eq("style-src", "'self'") && eq("connect-src", "'self'") && eq("worker-src", "'self'"), JSON.stringify(p));
  check(`${f}: object-src 'none'・base-uri 'none'・form-action 'none'`, eq("object-src", "'none'") && eq("base-uri", "'none'") && eq("form-action", "'none'"));
  check(`${f}: 'unsafe-inline' / 'unsafe-eval' / ワイルドカード / 外部ホスト / http: を含まない`, !/unsafe-|\*|https?:|\/\//.test(csps[i] || "x") || false, csps[i]);
  check(`${f}: img-src は自サイト・data:・blob: のみ、media-src は自サイト・blob: のみ`, eq("img-src", "'self' data: blob:") && eq("media-src", "'self' blob:"));
}
check("2つのページの CSP が同一", csps[0] === csps[1]);
const htaccess = read(".htaccess");
const hdr = (htaccess.match(/Header always set Content-Security-Policy "([^"]+)"/) || [])[1];
check(".htaccess の CSP は、ページの CSP + frame-ancestors 'none' と一致(ずれていない)", hdr === csps[0] + "; frame-ancestors 'none'", hdr);
check(".htaccess: X-Frame-Options DENY / nosniff / Referrer-Policy / Permissions-Policy / COOP を設定", ["X-Frame-Options \"DENY\"", "X-Content-Type-Options \"nosniff\"", "Referrer-Policy \"no-referrer\"", "Permissions-Policy", "Cross-Origin-Opener-Policy \"same-origin\""].every((x) => htaccess.includes(x)));
check(".htaccess: ディレクトリ一覧の禁止と、.md/package.json 等の非公開化", htaccess.includes("Options -Indexes") && /FilesMatch[^\n]*md/.test(htaccess) && htaccess.includes("Require all denied"));

// ---------- HTML ----------
for (const f of HTML) {
  const h = read(f);
  check(`${f}: インラインスクリプトがない(全ての <script> に src)`, [...h.matchAll(/<script\b([^>]*)>/gi)].every((m) => /\bsrc="[^"]+"/.test(m[1])));
  check(`${f}: インラインのイベントハンドラ(onclick 等)・style 属性・<style> がない`, !/\son[a-z]+\s*=/i.test(h) && !/\sstyle\s*=/i.test(h) && !/<style\b/i.test(h));
  check(`${f}: javascript: URL・iframe・object・embed・form・base・meta refresh がない`, !/javascript:/i.test(h) && !/<(iframe|object|embed|applet|form|base)\b/i.test(h) && !/http-equiv="refresh"/i.test(h));
  check(`${f}: 外部URL(http/https/プロトコル相対)を一切参照しない`, !/(?:src|href|action)\s*=\s*"(?:https?:)?\/\//i.test(h) && !/https?:\/\//i.test(h));
  check(`${f}: referrer は no-referrer、外部の link は無い(全て相対パス)`, h.includes('<meta name="referrer" content="no-referrer">') && [...h.matchAll(/<link\b[^>]*href="([^"]+)"/gi)].every((m) => !/^(?:[a-z]+:)?\/\//i.test(m[1])));
  check(`${f}: 外部サイトへ移動するリンク(<a href>)を持たない`, ![...h.matchAll(/<a\b[^>]*href="([^"]+)"/gi)].some((m) => /^(?:https?:)?\/\//i.test(m[1])));
}

// ---------- JavaScript（自作分） ----------
const BANNED = [
  [/\beval\s*\(/, "eval"], [/\bnew\s+Function\b/, "new Function"], [/\.innerHTML\b/, "innerHTML"], [/\.outerHTML\b/, "outerHTML"],
  [/insertAdjacentHTML/, "insertAdjacentHTML"], [/document\.write/, "document.write"],
  [/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open/, "ブラウザ保存領域"], [/XMLHttpRequest|WebSocket|EventSource|sendBeacon/, "通信API"],
  [/window\.open\b/, "window.open"], [/(window|parent|top|opener)\.postMessage/, "window間 postMessage"], [/addEventListener\(\s*["']message["']/, "message リスナー(window)"],
  [/\bset(Timeout|Interval)\(\s*["'`]/, "文字列タイマー"], [/document\.domain/, "document.domain"], [/\blocation\.(href|assign|replace)\s*=(?!\s*["'])/, "動的なページ遷移"],
  [/\bdangerouslySetInnerHTML\b|\bsrcdoc\b/, "srcdoc 等"],
];
for (const f of JS) {
  const code = stripComments(read(f));
  const hit = BANNED.filter(([re]) => re.test(code)).map(([, n]) => n);
  check(`${f}: 危険なAPI(eval/innerHTML/保存領域/通信API 等)を使っていない`, hit.length === 0, hit.join(","));
}
const rawAll = JS.map((f) => read(f)).join("\n");
const urls = [...stripComments(rawAll).matchAll(/https?:\/\/[A-Za-z0-9-]+\.[A-Za-z0-9.-]+[^\s"'`)]*/g)].map((m) => m[0]);   // ホスト名(ドット付き)を持つ URL のみ。案内文の "http://localhost" は対象外
check("JavaScript 内の外部URLは、CSP の遮断確認用のダミー(csp-test.invalid)だけ", urls.every((u) => u.includes("csp-test.invalid")), urls.join(" "));
check("importScripts / import() / fetch / new Worker は、固定の相対パスだけを使う", [...rawAll.matchAll(/(?:importScripts|import|fetch|new Worker)\(\s*([^)]*)\)/g)].filter((m) => !/^\s*(?:\{|\}|$)/.test(m[1])).every((m) => !/https?:|\/\//.test(m[1]) || m[1].includes("csp-test")), "");
const app = read("js/app.js"), sc = read("js/selfcheck.js"), wk = read("js/worker.js");
check("app.js / selfcheck.js: 他ページへの埋め込み検査が、DOM操作より先に行われる", app.indexOf("FMCore.isFramed(window)") > 0 && app.indexOf("FMCore.isFramed(window)") < app.indexOf("document.getElementById") && sc.indexOf("FMCore.isFramed(window)") > 0 && sc.indexOf("FMCore.isFramed(window)") < sc.indexOf("document.getElementById"));
check("worker.js: 受信メッセージの最初の処理が validateRequest(検証前に処理に入らない)", /self\.onmessage[\s\S]{0,200}FMCore\.validateRequest\(ev\.data\)/.test(wk));
check("worker.js: モデルは SHA-256 の照合に通ったものだけを検出器に渡す", wk.indexOf("sha256Hex(modelBytes)") > 0 && wk.indexOf("sha256Hex(modelBytes)") < wk.indexOf("createDynamicDetector(cv, FMCore, modelBytes)"));
check("app.js: ユーザー由来の文字列(ファイル名・エラー文)は textContent でのみ表示", /textContent/.test(app) && !/\.innerHTML|insertAdjacent/.test(app));

// ---------- CSS ----------
const css = read("style.css") + read("app.css");
check("CSS: @import・外部 url()・expression がない", !/@import/i.test(css) && !/url\(\s*["']?(?:https?:)?\/\//i.test(css) && !/expression\s*\(/i.test(css));
check("style.css は提供されたファイルのまま(無改変)", sha("style.css") === "80b13d89ba2e91e45f3877f7eafe778ddda8377b20a423d55539479376cfb172", sha("style.css"));

// ---------- 配布物・供給網 ----------
const files = (d) => fs.readdirSync(path.join(ROOT, d)).sort();
check("vendor/ は想定の3ファイルだけ(未知のスクリプトが紛れていない)", JSON.stringify(files("vendor")) === JSON.stringify(["VERSIONS.json", "mediabunny.min.js", "opencv.js"]), files("vendor").join());
check("models/ は想定のモデル1ファイルだけ", JSON.stringify(files("models")) === JSON.stringify(["face_detection_yunet_2026may.onnx"]), files("models").join());
const VER = JSON.parse(read("vendor/VERSIONS.json"));
check("同梱ライブラリ・モデルの SHA-256 が、VERSIONS.json の記録と一致", ["vendor/opencv.js", "vendor/mediabunny.min.js", "models/face_detection_yunet_2026may.onnx"].every((f) => sha(f) === VER[f].sha256), "");
const FM = require("../js/core.js");
check("モデルの固定ハッシュ(core.js)が、同梱モデルと VERSIONS.json に一致", sha("models/" + FM.C.MODEL_FILENAME) === FM.C.MODEL_SHA256 && VER["models/" + FM.C.MODEL_FILENAME].sha256 === FM.C.MODEL_SHA256);
const { build } = require("../tools/make-integrity.js");
check("integrity.json が最新(ファイルを変更したら node tools/make-integrity.js で再生成が必要)", JSON.stringify(build(), null, 2) + "\n" === read("integrity.json"));
const pkg = JSON.parse(read("package.json"));
check("package.json: 実行時の依存なし・インストール時スクリプトなし(供給網の攻撃面を減らす)", !pkg.dependencies && !Object.keys(pkg.scripts || {}).some((k) => /^(pre|post)?install$|^prepare$/.test(k)), JSON.stringify(pkg.scripts));
check("GitHub Actions を使わない(.github/ がない)", !fs.existsSync(path.join(ROOT, ".github")));
check(".nojekyll がある(Actions 無効でも、ブランチからの Pages 公開がビルド無しで成立する)", fs.existsSync(path.join(ROOT, ".nojekyll")));
check("SECURITY.md(脆弱性の報告方法)がある", read("SECURITY.md").includes("Report a vulnerability"));
const secrets = [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];
const scanFiles = [...HTML, ...JS, "app.css", "README.md", "SECURITY.md", "LICENSES.md", ".htaccess", "package.json", ...files("tools").map((f) => "tools/" + f), ...files("tests").filter((f) => /\.(js|py|sh|mjs)$/.test(f)).map((f) => "tests/" + f)];
check("秘密情報(トークン・秘密鍵)が混入していない", scanFiles.every((f) => !fs.existsSync(path.join(ROOT, f)) || secrets.every((re) => !re.test(read(f)))), "");

// ---------- 入力検証の単体 ----------
const bad = ["a\u202Eb.mp4", "../../x.mp4", "con.mp4", "a\x00b", "<>:\"/\\|?*"];
check("sanitizeName/safeBaseName: 危険な名前を無害化(制御文字・RLO・パス・予約名・記号のみ)", bad.every((n) => { const s = FM.safeBaseName(n); return s.length > 0 && !/[\u0000-\u001f\u202a-\u202e\\/:*?"<>|]/.test(s) && !/^\./.test(s) && !/^(con|prn|aux|nul)$/i.test(s); }), JSON.stringify(bad.map((n) => FM.safeBaseName(n))));
check("safeBaseName: 日本語はそのまま・極端に長い名前は切り詰め", FM.safeBaseName("山行記録 2026年10月.mp4") === "山行記録 2026年10月" && Array.from(FM.safeBaseName("あ".repeat(500) + ".mp4")).length <= 80);
check("estimateRemaining/formatDuration", FM.estimateRemaining(1, 0.5) === null && Math.abs(FM.estimateRemaining(30, 0.25) - 90) < 1e-9 && FM.formatDuration(90) === "1分30秒" && FM.formatDuration(3700) === "1時間1分" && FM.formatDuration(5) === "5秒");

console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
