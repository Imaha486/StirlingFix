# StirlingFix / HLP Viewer

バイナリエディタ **Stirling 1.31 (DDS2)** を Windows 10 / 11 で快適に使うための一式です。本体 `Stirling.exe` は**一切書き換えず**、同じフォルダに DLL を置くだけで次の難点を解消します。

| 難点 | 対策 |
| --- | --- |
| スクロールがカクつく・重い | `winspool.drv` シムで描画経路を差し替え |
| `.hlp` ヘルプが開けない（WinHlp32 が無い） | HTML1枚の HLP ビューアへリダイレクト |

> **対象:** 32bit 版 `Stirling.exe` 専用

---

## 目次

- [A. StirlingFix (winspool.drv) — 描画高速化シム](#a-stirlingfix-winspooldrv--描画高速化シム)
- [B. HlpViewer.html — HTML1枚の HLP ビューア](#b-hlpviewerhtml--html1枚の-hlp-ビューア)
- [導入](#導入)
- [設定 (StirlingFix.ini)](#設定-stirlingfixini)
- [ビルド](#ビルド)
- [構成ファイル](#構成ファイル)
- [注意](#注意)

---

## A. StirlingFix (winspool.drv) — 描画高速化シム

### 仕組み

`Stirling.exe` と同じフォルダに `winspool.drv` を置くと、起動時にまずこの DLL が読み込まれます（アプリと同じフォルダは Windows の DLL 検索で最優先）。本物の `winspool.drv` は `System32` から読み直し、全エクスポートをそのまま転送するので、**印刷など既存機能はそのまま動作**します。ゲームの描画を直す wrapper DLL と同じ「同梱 DLL 差し替え」方式で、本体 EXE には手を加えません。

### このシムが追加で行うこと（IAT フック）

1. **二重バッファ描画**
   `BeginPaint` / `EndPaint` を差し替え、全描画を一旦オフスクリーンビットマップへ描いてから一括転送。ちらつきと GPU 合成待ちをなくします。
2. **スクロールの作り直し**
   `ScrollWindow` を差し替え。元コードは「画面の既存ピクセルをずらして差分帯だけ再描画」しますが、これは DWM 合成環境では**画面バッファの読み戻しが高コスト**で、連続スクロールのカクつきの主因です。対象領域を丸ごと無効化し、二重バッファ経由で一枚絵として描き直すことで滑らかになります。
3. **高分解能ホイール**
   Stirling は「1 メッセージ = 1 ノッチ」前提で、高分解能ホイールやタッチパッドの細かい回転を取りこぼします。縦スクロールを持つ編集ビューをサブクラス化し、デルタを蓄積して行スクロールへ変換。`WheelMode=2` では 1 ノッチを複数行アニメーションとして流し、ぬるぬるスクロールになります。
4. **ヘルプのリダイレクト**（下記 B と連携）

---

## B. HlpViewer.html — HTML1枚の HLP ビューア

WinHelp (`.hlp`) を解析してブラウザ内で表示する**単一 HTML** です。外部ライブラリ・通信は一切なし。ファイルはすべてブラウザ内だけで処理されます。

### 使い方（2通り）

**(1) 手動で開く**
`HlpViewer.html` をブラウザで開き、`Stirling.hlp`（と `Stirling.cnt`）をウィンドウにドラッグ&ドロップ。または「開く…」から選択。

> `.cnt` も一緒に渡すと WinHelp と同じ目次ツリーになります。

**(2) 単体 HTML にして配布（F1 連携もこれ）**
一度開いてから「単体HTML保存」を押すと、`.hlp` / `.cnt` を埋め込んだ自己完結 HTML（例 `Stirling.help.html`）を書き出せます。以後はその 1 ファイルを開くだけ。同梱の `Stirling.help.html` は `Stirling.hlp` / `.cnt` を埋め込み済みです。

### 機能

- 目次（`.cnt`）/ キーワード索引 / 全文検索
- ポップアップ注釈・ジャンプ・マクロ（`JumpID` 等）リンク
- `<<` `>>` の前後トピック移動、戻る/進む履歴
- 埋め込み画像（`bmN`: SHG/MRB, RLE/LZ77）表示
- 文字サイズ拡大縮小、ライト/ダークテーマ
- URL ハッシュで直接ジャンプ

| ハッシュ | 動作 |
| --- | --- |
| `#contents` | 目次トピック |
| `#ctx=<数値>` | ヘルプコンテキスト ID / マップ ID |
| `#c=<文字列>` | コンテキスト文字列 |
| `#k=<キーワード>` | キーワード検索 |
| `#topic=<番号>` | トピック番号 |

StirlingFix は F1 ヘルプ要求を `Stirling.help.html#ctx=<ID>` の形で開くので、本体のヘルプ項目から該当ページへ直接飛べます。

### 対応形式

WinHelp 4.0（HC31, Windows 95/98/NT 世代）の `.hlp` に対応。`Stirling.hlp` はこの形式です。MVB や 3.0 旧形式は部分対応。

---

## 導入

`Stirling.exe` のフォルダに次を置くだけです。

```
Stirling.exe
winspool.drv          ← 描画高速化シム
StirlingFix.ini       ← 無ければ初回起動時に自動生成
Stirling.help.html    ← F1 ヘルプを使う場合
```

アンインストールは `winspool.drv` を消すだけ。

---

## 設定 (StirlingFix.ini)

```ini
[render]
DoubleBuffer=1      ; WM_PAINT の二重バッファ描画 (0/1)
ScrollMode=1        ; 0=元のScrollWindow 1=オフスクリーン全再描画(推奨)

[wheel]
WheelMode=2         ; 0=元のまま 1=120単位に整形 2=行単位アニメ(推奨)
WheelLines=0        ; 1ノッチの行数 (0=Windowsのマウス設定に従う)
WheelSpeed=14       ; アニメ1ステップのms。小さいほど速い(4〜60)

[help]
RedirectHelp=1      ; F1等の.hlpをブラウザのHLPビューアで開く (0/1)
Viewer=HlpViewer.html
Browser=            ; 空=OS既定ブラウザ。フルパス指定で特定ブラウザ

[debug]
Log=0               ; 1でStirlingFix.logに動作ログ
```

> まず `ScrollMode` / `WheelMode` を切り替えて体感を比べてください。相性問題が出たら該当項目を `0` に戻せば元の挙動に戻ります。

---

## ビルド

MinGW-w64 32bit クロス（Linux 例）。Windows の MSYS2/MinGW でも同じコマンドで通ります。

```bash
# 1) winspool.drv (シム本体)
i686-w64-mingw32-gcc -c thunks.S -o thunks.o
i686-w64-mingw32-gcc -O2 -s -shared -o winspool.drv stirlingfix.c thunks.o exports.def \
    -Wl,--enable-stdcall-fixup -lshlwapi -lshell32 -lgdi32 -luser32 -lkernel32 -limagehlp

# 2) HlpViewer.html (viewer.src.html に hlp.js を埋め込む)
python3 build.py

# 3) Stirling.help.html (.hlp/.cnt 埋め込み単体版)
node genstandalone.js Stirling.hlp Stirling.cnt Stirling.help.html
```

`thunks.S` / `exports.def` は `winspool.drv` の全エクスポートを本物へ転送するための自動生成物です。別バージョンの Windows に追従する場合は、本物の `winspool.drv` のエクスポート名から再生成してください。

---

## 構成ファイル

| ファイル | 内容 |
| --- | --- |
| `winspool.drv` | 描画高速化シム本体（32bit） |
| `StirlingFix.ini` | 設定ファイル（例）。消すと初回に自動生成 |
| `HlpViewer.html` | HLP ビューア（汎用。どの `.hlp` でも開ける） |
| `Stirling.help.html` | Stirling ヘルプ埋め込み済み単体版（F1 連携用） |
| `src/` | ソース一式（`stirlingfix.c`, `thunks.S`, `hlp.js` 等） |

---

## 注意

- **32bit 版 `Stirling.exe` 専用**です（本体が `winspool.drv` を使うため）。
- ウイルス対策ソフトが「`winspool.drv` を差し替える DLL」を警戒することがあります。誤検知の場合は除外登録してください。
- フックは `StirlingFix.ini` で個別に ON/OFF できます。合わなければ `winspool.drv` を削除するだけで完全に元へ戻せます。
