@echo off
REM ============================================================
REM  以"CDP 调试模式"启动本机 Chrome，让 walmart-playwright-mcp
REM  可以通过 chromium.connectOverCDP() 接管它。
REM
REM  PerimeterX 检测不到这种被"附加"控制的 Chrome（因为它本来
REM  就是真人启动的，不是 Playwright launch 出来的）。
REM ============================================================

setlocal
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "USER_DATA_DIR=%~dp0user-data"
set "DEBUG_PORT=9222"

if not exist "%CHROME%" (
  echo [ERROR] 找不到 Chrome 可执行文件: "%CHROME%"
  echo 请确认你已经安装了 Google Chrome。
  pause
  exit /b 1
)

if not exist "%USER_DATA_DIR%" mkdir "%USER_DATA_DIR%"

echo.
echo ================================================================
echo  Starting Google Chrome in CDP mode...
echo    user-data-dir : %USER_DATA_DIR%
echo    debug port    : %DEBUG_PORT%
echo ================================================================
echo.
echo  ▼▼▼  操作指南  ▼▼▼
echo   1. 等 Chrome 窗口打开后，手动逛 walmart.com 大约 2-3 分钟
echo      (搜个东西，点几个商品，往下滚一下，做出"我是真人"的样子)
echo   2. 如果一打开就弹 "Press And Hold" 验证，**手动按住完成它**
echo      (这一步只要做一次，cookies 会写入 user-data 目录)
echo   3. **不要关闭这个 Chrome 窗口！** 把它最小化即可
echo   4. 回到 PowerShell，执行：  node src\server.js
echo.

start "" "%CHROME%" ^
  --remote-debugging-port=%DEBUG_PORT% ^
  --user-data-dir="%USER_DATA_DIR%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-features=ChromeWhatsNewUI,SidePanelPinning ^
  https://www.walmart.com/

echo.
echo Chrome started. 这个 bat 窗口可以关掉。
echo.
timeout /t 5 >nul
endlocal
