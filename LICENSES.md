# 同梱物のライセンス

| 同梱物 | 内容 | ライセンス |
|---|---|---|
| `vendor/opencv.js` | OpenCV.js 5.0.0（npm `@techstark/opencv-js` 5.0.0-release.1）。顔検出(YuNet)・リサイズ・モザイクに使用 | Apache-2.0 |
| `vendor/mediabunny.min.js` | Mediabunny 1.61.3（動画の読み書き。無改変） | MPL-2.0（無改変で配布する場合、原本のソースへの案内が必要: https://github.com/Vanilagy/mediabunny） |
| `models/face_detection_yunet_2026may.onnx` | YuNet 顔検出モデル（dynamic-input 版）。**ご提供いただいたファイル**です | 入手元（opencv_zoo / libfacedetection）の表記に従ってください。**公開（再配布）の前に、入手元で条件を確認してください** |
| `style.css` | ご提供いただいたスタイル（無改変） | 提供元の方針に従う |
| `js/selfcheck.js` 内の顔画像 | scikit-image 同梱の宇宙飛行士の写真（NASA、パブリックドメイン） | パブリックドメイン |
| `js/*.js` `*.html` `app.css` `tools/` `tests/` | 本アプリ | 利用者の組織の方針に従う |

`vendor/VERSIONS.json` に、各ライブラリの出所・版・SHA-256 を記録しています。
