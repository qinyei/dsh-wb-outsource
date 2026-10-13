@echo off
title CodeBuddy CLI (WorkBuddy) - sign in with /login
echo ==========================================================
echo   CodeBuddy CLI  (WorkBuddy)
echo.
echo   Step 1: pick a login method with the arrow keys, Enter
echo           -^> choose "Log in via Chinese Site"
echo   Step 2: a browser window opens to finish sign-in
echo.
echo   (after that, this CLI is usable headless:
echo    codebuddy -p "your task" --model deepseek-v4.1-flash)
echo ==========================================================
echo.
where codebuddy >nul 2>nul
if errorlevel 1 (
  echo [warn] codebuddy not on PATH - falling back to the bundled headless CLI
  node "%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
) else (
  codebuddy
)
echo.
echo [CLI exited] press any key to close this window
pause >nul
