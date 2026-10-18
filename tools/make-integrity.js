#!/usr/bin/env node
// 公開するファイルの SHA-256 台帳 integrity.json を作る。公開前に手元で実行する（GitHub Actions は使わない）。
//   node tools/make-integrity.js
// 台帳に載せるのは「配信されるファイル」だけ（README・tests・tools・台帳自身は除く）。出力は決定的（時刻などを含まない）。
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const TARGETS = ["index.html", "selfcheck.html", "style.css", "app.css"];
const DIRS = { js: /\.js$/, vendor: /\.js$/, models: /\.onnx$/ };

function listFiles() {
  const out = [...TARGETS];
  for (const [dir, re] of Object.entries(DIRS)) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) if (re.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
}
function digest(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), size: buf.length };
}
function build() {
  const files = {};
  for (const rel of listFiles()) files[rel] = digest(rel);
  return { version: 1, files };
}
module.exports = { listFiles, digest, build };

if (require.main === module) {
  const manifest = build();
  const text = JSON.stringify(manifest, null, 2) + "\n";
  fs.writeFileSync(path.join(ROOT, "integrity.json"), text);
  const top = crypto.createHash("sha256").update(text).digest("hex");
  console.log(`integrity.json を作成しました（${Object.keys(manifest.files).length} ファイル）`);
  console.log(`integrity.json 自体の SHA-256: ${top}`);
}
