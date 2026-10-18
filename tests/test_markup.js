// 画面の整合性の静的検査: CSS に無いクラス名・HTML に無い id・重複 id・button の type 抜けなどを検出する。
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let passes = 0, fails = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "  [" + detail + "]" : "")); };

const css = read("style.css") + "\n" + read("app.css");
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
const pages = [["index.html", "js/app.js"], ["selfcheck.html", "js/selfcheck.js"]];

for (const [htmlFile, jsFile] of pages) {
  const html = read(htmlFile), js = read(jsFile);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  check(`${htmlFile}: id が重複していない`, new Set(ids).size === ids.length, ids.filter((x, i) => ids.indexOf(x) !== i).join());

  const used = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]).concat([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1])));
  const missing = [...used].filter((id) => !ids.includes(id));
  check(`${jsFile}: 参照している id(${used.size}個)が全て ${htmlFile} に存在する`, missing.length === 0, missing.join());

  const htmlClasses = new Set([...html.matchAll(/\sclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const jsClasses = new Set([
    ...[...js.matchAll(/classList\.(?:add|toggle|contains|remove)\("([^"]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/className\s*=\s*"([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)),
    ...[...js.matchAll(/"(?:status|check-item|verdict)[^"]*"/g)].flatMap((m) => m[0].replace(/"/g, "").split(/\s+/)),
    ...[...js.matchAll(/\? "(ok|warn|error|ng)"/g)].map((m) => m[1]),
  ].filter(Boolean));
  const unknown = [...new Set([...htmlClasses, ...jsClasses])].filter((c) => c && !cssClasses.has(c));
  check(`${htmlFile}/${jsFile}: 使っているクラス名が全て CSS(style.css / app.css) に定義されている`, unknown.length === 0, unknown.join());

  const labels = [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
  check(`${htmlFile}: <label for> の対象が存在する`, labels.every((id) => ids.includes(id)), labels.filter((id) => !ids.includes(id)).join());
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]);
  check(`${htmlFile}: 全ての <button> に type 指定がある`, buttons.every((a) => /\btype="/.test(a)), "");
  check(`${htmlFile}: <html lang="ja">・viewport・title がある`, /<html lang="ja">/.test(html) && /name="viewport"/.test(html) && /<title>[^<]+<\/title>/.test(html));
  check(`${htmlFile}: 画像(img)・canvas・video に代替テキスト/ラベルがある`, [...html.matchAll(/<(canvas)\b([^>]*)>/g)].every((m) => /aria-label=/.test(m[2])));
}
check("index.html: style.css を読み込み、app.css は style.css の後(上書きではなく追加)", read("index.html").indexOf('href="style.css"') < read("index.html").indexOf('href="app.css"') && read("index.html").indexOf('href="style.css"') > 0);
check("index.html: スクリプトの読み込み順は core.js → app.js(core の関数を使うため)", read("index.html").indexOf("js/core.js") > 0 && read("index.html").indexOf("js/core.js") < read("index.html").indexOf("js/app.js"));
check("style.css に定義のある主要クラスを画面が使っている(.app .panel .file-zone .preview .field .status .privacy .footer)", ["app", "panel", "file-zone", "preview", "field", "status", "privacy", "footer"].every((c) => new RegExp(`class="[^"]*\\b${c}\\b`).test(read("index.html"))));
console.log(`\n==== ${passes} 合格 / ${fails} 失敗`); process.exit(fails ? 1 : 0);
