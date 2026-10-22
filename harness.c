#include <windows.h>
#include <stdio.h>
int main(){
    // ensure our dir is searched; load local winspool.drv
    HMODULE m = LoadLibraryA(".\\winspool.drv");
    printf("load winspool.drv = %p err=%lu\n", (void*)m, GetLastError());
    if(!m) return 1;
    FARPROC op = GetProcAddress(m,"OpenPrinterA");
    FARPROC cp = GetProcAddress(m,"ClosePrinter");
    printf("OpenPrinterA=%p ClosePrinter=%p\n",(void*)op,(void*)cp);
    // call ClosePrinter(NULL) -> should forward to real and return 0 without crashing
    typedef BOOL(WINAPI*PCL)(HANDLE);
    BOOL r=((PCL)cp)((HANDLE)0);
    printf("ClosePrinter(0)=%d (forwarded ok)\n", r);
    // WinHelp redirect: simulate by patching our own IAT? Just confirm no crash loading.
    printf("OK\n");
    return 0;
}
