@echo off
rem Cai context-hub cho Claude Code tren Windows: kiem tra Node.js, giai nen
rem file context-hub-*.mcpb (de canh script nay hoac trong Downloads) vao
rem %USERPROFILE%\context-hub-mcp, roi chay trinh cai de gan vao Claude Code.
rem Chay: bam dup file nay. Tin nhan o day khong dau de cmd.exe hien dung.
setlocal
set "DEST=%USERPROFILE%\context-hub-mcp"

where node >nul 2>nul
if errorlevel 1 goto :no_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto :old_node

set "MCPB="
for /f "delims=" %%F in ('dir /b /o-d "%~dp0context-hub-*.mcpb" 2^>nul') do if not defined MCPB set "MCPB=%~dp0%%F"
if not defined MCPB for /f "delims=" %%F in ('dir /b /o-d "%USERPROFILE%\Downloads\context-hub-*.mcpb" 2^>nul') do if not defined MCPB set "MCPB=%USERPROFILE%\Downloads\%%F"
if not defined MCPB goto :no_mcpb

echo Dung %MCPB%
if not exist "%DEST%" mkdir "%DEST%"
tar -xf "%MCPB%" -C "%DEST%"
if errorlevel 1 goto :no_tar

node "%DEST%\server\index.mjs" --install
goto :end

:no_node
echo Chua co Node.js. Tai ban LTS tai https://nodejs.org (file .msi), cai xong chay lai file nay.
where winget >nul 2>nul
if errorlevel 1 goto :end
choice /m "Cai Node.js LTS ngay bang winget"
if errorlevel 2 goto :end
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo Cai xong. Dong cua so nay roi bam dup lai file cai dat.
goto :end

:old_node
echo Node.js da cu, can ban 22.13 tro len. Tai ban LTS tai https://nodejs.org roi chay lai.
goto :end

:no_mcpb
echo Khong thay file context-hub-*.mcpb. Tai o https://github.com/nghiant96/context-hub/releases/latest, de canh file nay hoac trong Downloads.
goto :end

:no_tar
echo Khong giai nen duoc. Doi duoi file .mcpb thanh .zip, chuot phai chon Extract All vao %DEST%, roi chay: node "%DEST%\server\index.mjs" --install

:end
echo.
pause
