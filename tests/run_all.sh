#!/usr/bin/env bash
# 自動テスト一式（Node.js 18+ と jsdom が必要: `npm install`）。
# GitHub Actions は使わないので、公開（git push）の前に、手元でこのスクリプトを実行する。
# 実ブラウザでの確認は、設置後に selfcheck.html で行うこと。
set -u
cd "$(dirname "$0")/.."
[ -d node_modules ] && export NODE_PATH="$PWD/node_modules${NODE_PATH:+:$NODE_PATH}"
fail=0
run() { local name="$1"; shift; echo; echo "=== $name"; "$@" 2>&1 | grep -E "^(PASS|FAIL|====|CRASH)"; [ "${PIPESTATUS[0]}" -eq 0 ] || fail=1; }
run "画面の整合性(クラス名・id・ラベル)"                                      node tests/test_markup.js
run "セキュリティ設定(CSP・禁止API・外部URL・整合性台帳・供給網)"          node tests/test_security.js
run "Python実装との一致(dynamic検出ロジック/追跡/割当/モザイク/ビットレート)" node tests/test_parity.js
run "本物のモデル×OpenCV.js: 実画像でPython(cv2)と同じ検出"                   node --expose-gc tests/test_realmodel.js
run "パイプライン結合(実OpenCV.js・リーク検査)"                               node --expose-gc tests/test_pipeline.js
run "Worker処理フロー・入力検証(偽Mediabunny/YuNet)"                          node --expose-gc tests/test_worker.js
run "画面ロジックとセキュリティ挙動(jsdom・偽Worker)"                          node tests/test_ui_jsdom.js
run "診断ページ(jsdom)"                                                        node tests/test_selfcheck_jsdom.js
echo; [ $fail -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit $fail
