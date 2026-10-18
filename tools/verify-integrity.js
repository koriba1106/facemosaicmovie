#!/usr/bin/env node
// 配置済みファイルが integrity.json と一致するかを確認する。  node tools/verify-integrity.js [フォルダ]
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(root, "integrity.json"), "utf8")); }
catch (e) { console.error("integrity.json を読めません:", e.message); process.exit(2); }
let bad = 0;
for (const [rel, meta] of Object.entries(manifest.files)) {
  const p = path.join(root, rel);
  if (!p.startsWith(root + path.sep)) { console.log("NG  不正なパス:", rel); bad++; continue; }
  let buf; try { buf = fs.readFileSync(p); } catch (e) { console.log("NG  ", rel, "（存在しません）"); bad++; continue; }
  const h = crypto.createHash("sha256").update(buf).digest("hex");
  if (buf.length !== meta.size || h !== meta.sha256) { console.log("NG  ", rel, "（内容が台帳と違います）"); bad++; } else console.log("OK  ", rel);
}
console.log(bad ? `\n${bad} 件が一致しません。` : "\nすべて一致しました。");
process.exit(bad ? 1 : 0);
