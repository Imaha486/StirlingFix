================================================================
 StirlingFix / HLP Viewer  一式
   Stirling 1.31 (DDS2) 向け 描画高速化シム + HLPビューア
   対象: Windows 10 / 11 (32bit版 Stirling.exe)
================================================================

Stirling は 1999 年の 32bit MFC アプリで、Windows 11 では
  (1) スクロールがカクつく・重い
  (2) .hlp ヘルプが標準では開けない（WinHlp32 が無い）
という難点があります。この一式はどちらも Stirling 本体を
書き換えずに解消します。


────────────────────────────────────────
 A. StirlingFix (winspool.drv) — 描画高速化シム
────────────────────────────────────────
■ 仕組み
  Stirling.exe と同じフォルダに winspool.drv を置くと、起動時に
  まずこの DLL が読み込まれます（アプリと同じフォルダは Windows の
  DLL 検索で最優先）。本物の winspool.drv は System32 から読み直し、
  全エクスポートをそのまま転送するので、印刷など既存機能はそのまま
  動きます。ゲームの描画を直す wrapper DLL と同じ「同梱DLL差し替え」
  方式で、本体 EXE には一切手を加えません。

■ この DLL が追加で行うこと（IATフック）
  1) 二重バッファ描画
     BeginPaint/EndPaint を差し替え、全描画を一旦オフスクリーン
     ビットマップへ描いてから一括転送。ちらつきと GPU 合成待ちを
     なくします。
  2) スクロールの作り直し
     ScrollWindow を差し替え。元コードは「画面の既存ピクセルを
     ずらして差分帯だけ再描画」しますが、これは DWM 合成環境では
     画面バッファの読み戻しが高コストで、連続スクロールのカクつき
     の主因です。対象領域を丸ごと無効化し、二重バッファ経由で
     一枚絵として描き直すことで滑らかになります。
  3) 高分解能ホイール
     Stirling は 1 メッセージ=1 ノッチ前提で高分解能ホイールや
     タッチパッドの細かい回転を取りこぼします。縦スクロールを持つ
     編集ビューをサブクラス化し、デルタを蓄積して行スクロールへ
     変換。WheelMode=2 では 1 ノッチを複数行アニメーションとして
     流し、ぬるぬるスクロールになります。
  4) ヘルプのリダイレクト（下記 B と連携）

■ 導入
  Stirling.exe のフォルダに次を置くだけ:
     winspool.drv
     StirlingFix.ini        (無ければ初回起動時に自動生成)
     Stirling.help.html     (B のヘルプ。F1 ヘルプを使う場合)
  アンインストールは winspool.drv を消すだけ。

■ 設定 (StirlingFix.ini)
  [render]
    DoubleBuffer=1   二重バッファ描画 (0/1)
    ScrollMode=1     0=元のScrollWindow 1=オフスクリーン全再描画(推奨)
  [wheel]
    WheelMode=2      0=元のまま 1=120単位に整形 2=行単位アニメ(推奨)
    WheelLines=0     1ノッチの行数 (0=Windowsのマウス設定に従う)
    WheelSpeed=14    アニメ1ステップのms。小さいほど速い(4〜60)
  [help]
    RedirectHelp=1   F1等の.hlpをブラウザのHLPビューアで開く
    Viewer=HlpViewer.html
    Browser=         空=OS既定ブラウザ。フルパス指定で特定ブラウザ
  [debug]
    Log=0            1でStirlingFix.logに動作ログ

■ 注意
  ・32bit版 Stirling.exe 専用です（本体が winspool.drv を使うため）。
  ・ウイルス対策ソフトが「winspool.drv を差し替えるDLL」を警戒する
    ことがあります。誤検知の場合は除外登録してください。
  ・まず ScrollMode / WheelMode を切り替えて体感を比べてください。
    相性問題が出たら該当項目を 0 に戻せば元の挙動に戻ります。


────────────────────────────────────────
 B. HlpViewer.html — HTML1枚のHLPビューア
────────────────────────────────────────
  WinHelp(.hlp) を解析してブラウザ内で表示する単一HTMLです。外部
  ライブラリ・通信は一切なし。ファイルはすべてブラウザ内だけで処理
  されます。

■ 使い方（2通り）
  (1) 手動で開く
      HlpViewer.html をブラウザで開き、Stirling.hlp（と Stirling.cnt）
      をウィンドウにドラッグ&ドロップ。または「開く…」から選択。
      ・.cnt も一緒に渡すと WinHelp と同じ目次ツリーになります。
  (2) 単体HTMLにして配布（F1連携もこれ）
      一度開いてから「単体HTML保存」を押すと、.hlp/.cnt を埋め込んだ
      自己完結HTML（例 Stirling.help.html）を書き出せます。以後は
      その1ファイルを開くだけ。同梱の Stirling.help.html は
      Stirling.hlp/.cnt を埋め込み済みのものです。

■ 機能
  ・目次（.cnt）/ キーワード索引 / 全文検索
  ・ポップアップ注釈・ジャンプ・マクロ(JumpID等)リンク
  ・<< >> の前後トピック移動、戻る/進む履歴
  ・埋め込み画像(bmN: SHG/MRB, RLE/LZ77)表示
  ・文字サイズ拡大縮小、ライト/ダークテーマ
  ・URLハッシュで直接ジャンプ:
       #contents            目次トピック
       #ctx=<数値>          ヘルプコンテキストID / マップID
       #c=<コンテキスト文字列>
       #k=<キーワード>
       #topic=<番号>
    StirlingFix は F1 ヘルプ要求を
       Stirling.help.html#ctx=<ID>
    の形で開くので、本体のヘルプ項目から該当ページへ直接飛べます。

■ 対応
  WinHelp 4.0 (HC31, Windows 95/98/NT 世代) の .hlp に対応。
  Stirling.hlp はこの形式です。MVB や 3.0 旧形式は部分対応。


────────────────────────────────────────
 構成ファイル
────────────────────────────────────────
  winspool.drv          描画高速化シム本体(32bit)
  StirlingFix.ini       設定ファイル(例)。消すと初回に自動生成
  HlpViewer.html        HLPビューア(汎用。どの.hlpでも開ける)
  Stirling.help.html    Stirlingヘルプ埋め込み済み単体版(F1連携用)
  src/                  ソース一式(stirlingfix.c, thunks.S, hlp.js 等)
  README.txt            このファイル

  ※ winspool.drv・StirlingFix.ini・Stirling.help.html を Stirling.exe
     のフォルダへ。HlpViewer.html は手元で任意の.hlpを開く用に別途
     持っておくと便利です。
