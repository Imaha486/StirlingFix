/*
 * StirlingFix — Stirling 1.31 (DDS2) 用の描画高速化シム
 *
 * winspool.drv と同名で Stirling.exe と同じフォルダに置くと、Stirling が起動時に
 * これを読み込む。本物の winspool.drv は System32 から読み直して全エクスポートを
 * そのまま転送するので、印刷など既存機能はそのまま動く。
 * 本シムが追加で行うのは次の 4 点だけ:
 *   1. WM_PAINT をオフスクリーン DC に二重描画し、ちらつき・GPU 合成待ちをなくす
 *   2. ScrollWindow をオフスクリーン全再描画に置き換え（DWM サーフェスからの読み戻しを回避）
 *   3. 高分解能ホイール（WM_MOUSEWHEEL のデルタ蓄積＋行単位アニメーション）
 *   4. WinHelp(.hlp) 起動を同梱の HlpViewer.html（ブラウザ）にリダイレクト
 * すべて StirlingFix.ini で個別に ON/OFF 可能。
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdarg.h>
#include <imagehlp.h>

/* ---- 転送テーブル（thunks.S で生成） ---- */
extern void *g_thunkPtr[];
extern const char *g_thunkNames[];
extern int g_thunkCount;

static HMODULE g_real;              /* 本物の winspool.drv */
static HINSTANCE g_self;
static WCHAR g_dir[MAX_PATH];       /* 本 DLL（= Stirling.exe）のあるフォルダ */

static int cfgDoubleBuffer = 1;
static int cfgScrollMode   = 1;     /* 0=元の ScrollWindow, 1=オフスクリーン全再描画 */
static int cfgWheelMode    = 2;     /* 0=元のまま, 1=120 単位に整形, 2=行単位アニメ */
static int cfgWheelLines   = 0;     /* 0 = システム設定に従う */
static int cfgWheelSpeed   = 14;    /* アニメ 1 ステップあたり ms */
static int cfgHelp         = 1;
static int cfgLog          = 0;
static WCHAR cfgViewer[MAX_PATH] = L"HlpViewer.html";
static WCHAR cfgBrowser[1024]    = L"";

static void Log(const char *fmt, ...)
{
    if (!cfgLog) return;
    WCHAR p[MAX_PATH]; wsprintfW(p, L"%sStirlingFix.log", g_dir);
    FILE *f = _wfopen(p, L"a"); if (!f) return;
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(f, "%02d:%02d:%02d.%03d ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fputc('\n', f); fclose(f);
}

static void LoadReal(void)
{
    if (g_real) return;
    WCHAR p[MAX_PATH];
    GetSystemDirectoryW(p, MAX_PATH);          /* 32bit プロセスなので SysWOW64 に解決される */
    lstrcatW(p, L"\\winspool.drv");
    g_real = LoadLibraryW(p);
    if (!g_real) Log("real winspool.drv load failed (%lu)", GetLastError());
}

/* 未解決エクスポートに来たときのダミー（呼ばれることはまずない） */
static int __stdcall MissingStub(void) { SetLastError(ERROR_PROC_NOT_FOUND); return 0; }

/* thunks.S から呼ばれる。初回アクセス時に本物のアドレスを引いてテーブルへ書き込む */
void * __stdcall ResolveThunk(int idx)
{
    LoadReal();
    void *p = g_real ? (void*)GetProcAddress(g_real, g_thunkNames[idx]) : NULL;
    if (!p) p = (void*)MissingStub;
    g_thunkPtr[idx] = p;
    return p;
}

/* ============================================================
 *  設定読み込み
 * ============================================================ */
static void LoadConfig(void)
{
    WCHAR ini[MAX_PATH]; wsprintfW(ini, L"%sStirlingFix.ini", g_dir);
    if (GetFileAttributesW(ini) == INVALID_FILE_ATTRIBUTES) {
        /* 初回: 既定値の ini を書き出しておく（ユーザーが後から編集できるように） */
        FILE *f = _wfopen(ini, L"w, ccs=UTF-8");
        if (f) {
            fwprintf(f,
                L"; StirlingFix 設定ファイル\r\n"
                L"[render]\r\n"
                L"DoubleBuffer=1      ; WM_PAINT の二重バッファ描画 (0/1)\r\n"
                L"ScrollMode=1        ; 0=元のScrollWindow 1=オフスクリーン全再描画\r\n"
                L"\r\n[wheel]\r\n"
                L"WheelMode=2         ; 0=元のまま 1=120単位に整形 2=行単位アニメ\r\n"
                L"WheelLines=0        ; 1ノッチの行数 (0=システム設定)\r\n"
                L"WheelSpeed=14       ; アニメ1ステップのms (小さいほど速い)\r\n"
                L"\r\n[help]\r\n"
                L"RedirectHelp=1      ; .hlp をブラウザのHLPビューアで開く (0/1)\r\n"
                L"Viewer=HlpViewer.html\r\n"
                L"Browser=            ; 空ならOS既定ブラウザ。例: C:\\Program Files\\Firefox\\firefox.exe\r\n"
                L"\r\n[debug]\r\n"
                L"Log=0\r\n");
            fclose(f);
        }
    }
    cfgDoubleBuffer = GetPrivateProfileIntW(L"render", L"DoubleBuffer", 1, ini);
    cfgScrollMode   = GetPrivateProfileIntW(L"render", L"ScrollMode",   1, ini);
    cfgWheelMode    = GetPrivateProfileIntW(L"wheel",  L"WheelMode",    2, ini);
    cfgWheelLines   = GetPrivateProfileIntW(L"wheel",  L"WheelLines",   0, ini);
    cfgWheelSpeed   = GetPrivateProfileIntW(L"wheel",  L"WheelSpeed",  14, ini);
    cfgHelp         = GetPrivateProfileIntW(L"help",   L"RedirectHelp", 1, ini);
    cfgLog          = GetPrivateProfileIntW(L"debug",  L"Log",          0, ini);
    GetPrivateProfileStringW(L"help", L"Viewer",  L"HlpViewer.html", cfgViewer,  MAX_PATH, ini);
    GetPrivateProfileStringW(L"help", L"Browser", L"",               cfgBrowser, 1024,     ini);
    if (cfgWheelSpeed < 4)  cfgWheelSpeed = 4;
    if (cfgWheelSpeed > 60) cfgWheelSpeed = 60;
}

/* ============================================================
 *  API フック（IAT 書き換え）
 * ============================================================ */
typedef BOOL (WINAPI *PFN_GetMessageA)(LPMSG,HWND,UINT,UINT);
typedef BOOL (WINAPI *PFN_PeekMessageA)(LPMSG,HWND,UINT,UINT,UINT);
typedef HDC (WINAPI *PFN_BeginPaint)(HWND,LPPAINTSTRUCT);
typedef BOOL (WINAPI *PFN_EndPaint)(HWND,const PAINTSTRUCT*);
typedef int  (WINAPI *PFN_ScrollWindowEx)(HWND,int,int,const RECT*,const RECT*,HRGN,LPRECT,UINT);
typedef BOOL (WINAPI *PFN_ScrollWindow)(HWND,int,int,const RECT*,const RECT*);
typedef BOOL (WINAPI *PFN_WinHelpA)(HWND,LPCSTR,UINT,ULONG_PTR);

static PFN_BeginPaint      p_BeginPaint;
static PFN_EndPaint        p_EndPaint;
static PFN_ScrollWindow    p_ScrollWindow;
static PFN_WinHelpA        p_WinHelpA;

/* ---- オフスクリーン二重バッファ: BeginPaint/EndPaint 差し替え ---- */
typedef struct { HWND hwnd; HDC memdc; HBITMAP bmp, old; HDC realdc; PAINTSTRUCT ps; int w,h; } PAINTCTX;
static PAINTCTX g_paint[16];
static CRITICAL_SECTION g_cs;

static HDC WINAPI My_BeginPaint(HWND hwnd, LPPAINTSTRUCT ps)
{
    HDC real = p_BeginPaint(hwnd, ps);
    if (!cfgDoubleBuffer || !real) return real;
    RECT rc; GetClientRect(hwnd, &rc);
    int w = rc.right, h = rc.bottom;
    if (w <= 0 || h <= 0) return real;
    EnterCriticalSection(&g_cs);
    PAINTCTX *c = NULL;
    for (int i = 0; i < 16; i++) if (!g_paint[i].hwnd) { c = &g_paint[i]; break; }
    if (!c) { LeaveCriticalSection(&g_cs); return real; }
    c->hwnd = hwnd; c->realdc = real; c->ps = *ps; c->w = w; c->h = h;
    c->memdc = CreateCompatibleDC(real);
    c->bmp   = CreateCompatibleBitmap(real, w, h);
    c->old   = (HBITMAP)SelectObject(c->memdc, c->bmp);
    LeaveCriticalSection(&g_cs);
    /* アプリにはメモリ DC を返す。背景は実 DC からコピーしておく（部分再描画対策） */
    BitBlt(c->memdc, 0, 0, w, h, real, 0, 0, SRCCOPY);
    ps->hdc = c->memdc;
    return c->memdc;
}

static BOOL WINAPI My_EndPaint(HWND hwnd, const PAINTSTRUCT *ps)
{
    if (cfgDoubleBuffer) {
        EnterCriticalSection(&g_cs);
        for (int i = 0; i < 16; i++) {
            PAINTCTX *c = &g_paint[i];
            if (c->hwnd == hwnd && c->memdc == ps->hdc) {
                BitBlt(c->realdc, 0, 0, c->w, c->h, c->memdc, 0, 0, SRCCOPY);
                SelectObject(c->memdc, c->old);
                DeleteObject(c->bmp); DeleteDC(c->memdc);
                PAINTSTRUCT real = c->ps;
                ZeroMemory(c, sizeof(*c));
                LeaveCriticalSection(&g_cs);
                return p_EndPaint(hwnd, &real);
            }
        }
        LeaveCriticalSection(&g_cs);
    }
    return p_EndPaint(hwnd, ps);
}

/* ---- ScrollWindow 差し替え: 画面からの読み戻しをやめ、全面を無効化して一度に再描画 ---- */
static BOOL WINAPI My_ScrollWindow(HWND hwnd, int dx, int dy, const RECT *scroll, const RECT *clip)
{
    if (cfgScrollMode == 0)
        return p_ScrollWindow(hwnd, dx, dy, scroll, clip);
    /*
     * 元コードは ScrollWindow で既存ピクセルをずらし、差分帯だけ再描画する。
     * これは DWM 合成環境では「画面バッファの読み戻し」が高コストで、
     * 連続スクロール時にカクつく主因になる。
     * ここでは当該領域を丸ごと無効化し、二重バッファ経由で一枚絵として描き直す。
     * ScrollWindow のキャレット移動相当は親の再描画に含まれるため不要。
     */
    RECT rc; const RECT *area = scroll;
    if (!area) { GetClientRect(hwnd, &rc); area = &rc; }
    /* スクロール対象領域を無効化し、アプリ自身の WM_PAINT に一枚絵として描き直させる。
       二重バッファ(My_BeginPaint)経由なのでちらつかない。clip 指定時はその交差領域のみ。 */
    if (clip) {
        RECT inter; if (IntersectRect(&inter, area, clip)) InvalidateRect(hwnd, &inter, FALSE);
    } else {
        InvalidateRect(hwnd, area, FALSE);
    }
    UpdateWindow(hwnd);
    return TRUE;
}

/* ============================================================
 *  高分解能ホイール
 *   Stirling は 1 メッセージ=1 ノッチ前提で +120 単位しか扱わないため、
 *   高分解能ホイール/タッチパッドの細かいデルタを取りこぼす。
 *   サブクラスでデルタを蓄積し、120 ごとに行スクロール（WM_VSCROLL）へ変換する。
 *   WheelMode=2 では 1 ノッチを複数行アニメーションとして流し込み、滑らかに見せる。
 * ============================================================ */
static int g_accum = 0;
static void TrySubclass(HWND hwnd);
static BOOL CALLBACK TrySubclassEnum(HWND hwnd, LPARAM lp);

static void PostLines(HWND hwnd, int lines)   /* lines>0 = 上方向 */
{
    int code = lines > 0 ? SB_LINEUP : SB_LINEDOWN;
    int n = lines > 0 ? lines : -lines;
    for (int i = 0; i < n; i++)
        SendMessageW(hwnd, WM_VSCROLL, MAKEWPARAM(code, 0), 0);
    SendMessageW(hwnd, WM_VSCROLL, MAKEWPARAM(SB_ENDSCROLL, 0), 0);
}

static UINT WheelLinesPerNotch(void)
{
    if (cfgWheelLines > 0) return cfgWheelLines;
    UINT n = 3; SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &n, 0);
    if (n == 0) n = 3;                 /* 0 = ページ単位。ここでは 3 行に丸める */
    if (n == (UINT)-1 || n > 100) n = 3;
    return n;
}

/* サブクラス: WM_MOUSEWHEEL を横取りして行スクロールへ */
static WNDPROC g_origProc[64];
static HWND    g_subHwnd[64];
static int     g_subN = 0;

static LRESULT CALLBACK WheelProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    WNDPROC orig = NULL;
    for (int i = 0; i < g_subN; i++) if (g_subHwnd[i] == hwnd) { orig = g_origProc[i]; break; }
    if (!orig) return DefWindowProcW(hwnd, msg, wp, lp);

    if (msg == WM_MOUSEWHEEL && cfgWheelMode != 0) {
        int delta = GET_WHEEL_DELTA_WPARAM(wp);
        g_accum += delta;
        int notches = g_accum / WHEEL_DELTA;
        g_accum -= notches * WHEEL_DELTA;
        if (notches != 0) {
            int lines = notches * (int)WheelLinesPerNotch();
            if (cfgWheelMode == 2) {
                /* 行単位アニメーション: 1 行ずつ UpdateWindow を挟んで流す */
                int step = lines > 0 ? 1 : -1, n = lines > 0 ? lines : -lines;
                for (int i = 0; i < n; i++) {
                    PostLines(hwnd, step);
                    UpdateWindow(hwnd);
                    if (cfgWheelSpeed && n > 1) Sleep(cfgWheelSpeed);
                }
            } else {
                PostLines(hwnd, lines);
            }
        }
        return 0;
    }
    if (msg == WM_NCDESTROY) {
        LRESULT r = CallWindowProcW(orig, hwnd, msg, wp, lp);
        for (int i = 0; i < g_subN; i++) if (g_subHwnd[i] == hwnd) { g_subHwnd[i] = NULL; g_origProc[i] = NULL; }
        return r;
    }
    return CallWindowProcW(orig, hwnd, msg, wp, lp);
}

/* 子ウィンドウ（編集ビュー）を見つけたらサブクラス化する。CBT フックから呼ぶ */
static void TrySubclass(HWND hwnd)
{
    if (cfgWheelMode == 0) return;
    for (int i = 0; i < g_subN; i++) if (g_subHwnd[i] == hwnd) return;
    if (g_subN >= 64) return;
    /* Stirling の編集ビュークラス名（AfxWnd 系）に限定せず、
       縦スクロールバーを持つ子ウィンドウを対象にする */
    LONG style = GetWindowLongW(hwnd, GWL_STYLE);
    if (!(style & WS_VSCROLL)) return;
    WNDPROC orig = (WNDPROC)SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)WheelProc);
    g_subHwnd[g_subN] = hwnd; g_origProc[g_subN] = orig; g_subN++;
    Log("subclassed hwnd=%p style=%08lx", hwnd, style);
}

static HHOOK g_cbt;
static LRESULT CALLBACK CbtHook(int code, WPARAM wp, LPARAM lp)
{
    if (code == HCBT_CREATEWND) {
        /* 作成直後はまだスタイルが確定しない場合があるので、少し遅らせて拾う */
    } else if (code == HCBT_ACTIVATE || code == HCBT_SETFOCUS) {
        HWND h = (HWND)wp;
        EnumChildWindows(GetAncestor(h, GA_ROOT), (WNDENUMPROC)(void*)TrySubclassEnum, 0);
    }
    return CallNextHookEx(g_cbt, code, wp, lp);
}
/* EnumChildWindows 用ラッパ */
static BOOL CALLBACK TrySubclassEnum(HWND hwnd, LPARAM lp) { TrySubclass(hwnd); return TRUE; }

/* ============================================================
 *  WinHelp リダイレクト
 * ============================================================ */
static void BuildHelpUrl(LPCSTR hlpPath, UINT cmd, ULONG_PTR data, WCHAR *url, int cch)
{
    /* hlpPath は "Stirling.hlp" や "Stirling.hlp>main" のことがある */
    WCHAR hlpW[MAX_PATH]; MultiByteToWideChar(CP_ACP, 0, hlpPath, -1, hlpW, MAX_PATH);
    WCHAR *gt = wcschr(hlpW, L'>'); if (gt) *gt = 0;
    /* フルパス化 */
    WCHAR full[MAX_PATH];
    if (PathIsRelativeW(hlpW)) wsprintfW(full, L"%s%s", g_dir, hlpW);
    else lstrcpynW(full, hlpW, MAX_PATH);

    /* ジャンプ先フラグメント */
    WCHAR frag[128] = L"";
    if (cmd == HELP_CONTEXT || cmd == 0x0001)              wsprintfW(frag, L"ctx=%lu", (unsigned long)data);
    else if (cmd == HELP_CONTENTS || cmd == 0x0003 || cmd == 0x000B) lstrcpyW(frag, L"contents");
    else if (cmd == HELP_KEY || cmd == 0x0101 || cmd == HELP_PARTIALKEY || cmd == 0x0105) {
        WCHAR kw[96]; MultiByteToWideChar(CP_ACP, 0, (LPCSTR)data, -1, kw, 96);
        wsprintfW(frag, L"k=%s", kw);
    }

    /*
     * 最優先: ".hlp" と同じ基底名の単体HTML（例 Stirling.help.html）。
     * これは .hlp/.cnt を base64 埋め込み済みなので、file:// でも JS からファイルを
     * 読まずに表示でき、ブラウザのローカルファイル制約を回避できる。
     * 無ければ ?hlp= 付きでビューアを開く（http 配信時や手動ドロップ時のフォールバック）。
     */
    WCHAR base[MAX_PATH]; lstrcpynW(base, full, MAX_PATH);
    WCHAR *dot = wcsrchr(base, L'.'); if (dot) *dot = 0;
    WCHAR standalone[MAX_PATH]; wsprintfW(standalone, L"%s.help.html", base);
    if (GetFileAttributesW(standalone) != INVALID_FILE_ATTRIBUTES) {
        _snwprintf(url, cch, L"%s#%s", standalone, frag);
        return;
    }
    WCHAR viewer[MAX_PATH];
    if (PathIsRelativeW(cfgViewer)) wsprintfW(viewer, L"%s%s", g_dir, cfgViewer);
    else lstrcpynW(viewer, cfgViewer, MAX_PATH);
    _snwprintf(url, cch, L"%s?hlp=%s#%s", viewer, full, frag);
}

static BOOL WINAPI My_WinHelpA(HWND hwnd, LPCSTR hlp, UINT cmd, ULONG_PTR data)
{
    if (!cfgHelp) return p_WinHelpA ? p_WinHelpA(hwnd, hlp, cmd, data) : FALSE;
    if (cmd == HELP_QUIT || cmd == 0x0002) return TRUE;   /* 終了要求は無視 */
    if (!hlp || !*hlp) return TRUE;

    WCHAR url[MAX_PATH * 2];
    BuildHelpUrl(hlp, cmd, data, url, MAX_PATH * 2);
    Log("WinHelp cmd=%u -> %ls", cmd, url);

    if (cfgBrowser[0]) {
        WCHAR args[MAX_PATH * 2]; wsprintfW(args, L"\"%s\"", url);
        ShellExecuteW(hwnd, L"open", cfgBrowser, args, g_dir, SW_SHOWNORMAL);
    } else {
        ShellExecuteW(hwnd, L"open", url, NULL, g_dir, SW_SHOWNORMAL);
    }
    return TRUE;
}

/* ============================================================
 *  IAT パッチ
 * ============================================================ */
static void PatchIAT(HMODULE mod, const char *dll, const char *fn, void *newfn, void **oldfn)
{
    ULONG size;
    IMAGE_IMPORT_DESCRIPTOR *imp = (IMAGE_IMPORT_DESCRIPTOR*)
        ImageDirectoryEntryToData(mod, TRUE, IMAGE_DIRECTORY_ENTRY_IMPORT, &size);
    if (!imp) return;
    BYTE *b = (BYTE*)mod;
    for (; imp->Name; imp++) {
        const char *name = (const char*)(b + imp->Name);
        if (lstrcmpiA(name, dll) != 0) continue;
        IMAGE_THUNK_DATA *orig = (IMAGE_THUNK_DATA*)(b + imp->OriginalFirstThunk);
        IMAGE_THUNK_DATA *iat  = (IMAGE_THUNK_DATA*)(b + imp->FirstThunk);
        if (!imp->OriginalFirstThunk) orig = iat;
        for (; orig->u1.AddressOfData; orig++, iat++) {
            if (orig->u1.Ordinal & IMAGE_ORDINAL_FLAG) continue;
            IMAGE_IMPORT_BY_NAME *ibn = (IMAGE_IMPORT_BY_NAME*)(b + orig->u1.AddressOfData);
            if (lstrcmpiA((const char*)ibn->Name, fn) != 0) continue;
            DWORD old; VirtualProtect(&iat->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
            if (oldfn && !*oldfn) *oldfn = (void*)(ULONG_PTR)iat->u1.Function;
            iat->u1.Function = (ULONG_PTR)newfn;
            VirtualProtect(&iat->u1.Function, sizeof(void*), old, &old);
            Log("patched %s!%s", dll, fn);
            return;
        }
    }
}

static void InstallHooks(void)
{
    HMODULE exe = GetModuleHandleW(NULL);
    PatchIAT(exe, "user32.dll", "BeginPaint",   (void*)My_BeginPaint,   (void**)&p_BeginPaint);
    PatchIAT(exe, "user32.dll", "EndPaint",     (void*)My_EndPaint,     (void**)&p_EndPaint);
    PatchIAT(exe, "user32.dll", "ScrollWindow", (void*)My_ScrollWindow, (void**)&p_ScrollWindow);
    PatchIAT(exe, "user32.dll", "WinHelpA",     (void*)My_WinHelpA,     (void**)&p_WinHelpA);

    /* 既存ウィンドウにサブクラスを適用 + 以後の生成を CBT フックで拾う */
    if (cfgWheelMode != 0) {
        EnumChildWindows(GetDesktopWindow(), (WNDENUMPROC)(void*)TrySubclassEnum, 0);
        g_cbt = SetWindowsHookExW(WH_CBT, CbtHook, NULL, GetCurrentThreadId());
    }
}

/* ============================================================
 *  エントリ
 * ============================================================ */
BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID res)
{
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = inst;
        DisableThreadLibraryCalls(inst);
        InitializeCriticalSection(&g_cs);
        GetModuleFileNameW(inst, g_dir, MAX_PATH);
        WCHAR *bs = wcsrchr(g_dir, L'\\'); if (bs) bs[1] = 0;
        LoadConfig();
        Log("StirlingFix attach. dir=%ls dbuf=%d scroll=%d wheel=%d help=%d",
            g_dir, cfgDoubleBuffer, cfgScrollMode, cfgWheelMode, cfgHelp);
        /* Stirling 本体の IAT が整うよう、最初のメッセージループ前に入れたいが、
           DllMain 時点で EXE の IAT は確定済みなのでここで掛けてよい */
        InstallHooks();
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_cbt) UnhookWindowsHookEx(g_cbt);
        DeleteCriticalSection(&g_cs);
    }
    return TRUE;
}
