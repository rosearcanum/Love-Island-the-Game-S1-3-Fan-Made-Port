@echo off
setlocal
cd /d "%~dp0"
title Love Island - building your games
if not exist "extract_season.py" (
  echo Run this from inside the LoveIsland_PC folder, after unzipping it.
  pause
  exit /b
)
rem Old step-by-step launchers are replaced by this one button.
for %%f in ("1 - Convert seasons.bat" "2 - Play.bat" "3 - Build exe.bat" "4 - Shrink music.bat") do if exist %%f del %%f
rem Find Python 3.14 (or 3.13/3.12): the converter's libraries and PyInstaller aren't ready for 3.15 yet.
set PY=
set PYTHON_MANAGER_AUTOMATIC_INSTALL=false
for %%p in ("%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe" "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" "%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe" "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" "%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe" "%LOCALAPPDATA%\Programs\Python\Python312\python.exe") do (
  if not defined PY (
    if exist %%p set PY=%%p
  )
)
for %%v in (3.14 3.13 3.12) do (
  if not defined PY (
    py -%%v -c "import sys" <nul >nul 2>nul && set PY=py -%%v
  )
)
if not defined PY (
  where py >nul 2>nul && set PY=py
)
if not defined PY (
  echo Python isn't installed on this PC. Install Python 3.14 from python.org, then run this again.
  pause
  exit /b
)
echo Using: %PY%
echo.
echo [1/5] Converting seasons - only what's new...
%PY% extract_season.py --batch
echo.
echo [2/5] Shrinking the music...
%PY% compress_audio.py --batch
echo.
echo [3/5] Packing all seasons into one file...
%PY% pack_data.py
if errorlevel 1 goto fail
echo.
echo [4/5] Building Love Island.exe - this takes a few minutes...
%PY% -m pip install -q --disable-pip-version-check --upgrade pyinstaller
%PY% -m PyInstaller --noconfirm --log-level WARN --onefile --windowed --name "Love Island" --icon "%CD%\icon.ico" --add-data "%CD%\player;player" --add-data "%CD%\build\LoveIsland.data;." --distpath "%CD%\Your games" --workpath "%CD%\build\pyi" --specpath "%CD%\build\pyi" "%CD%\play.py"
if errorlevel 1 goto fail
echo.
echo [5/5] Building the phone app...
call "%CD%\android\build_apk.bat"
echo.
echo ============================================================
echo  Done! Your games are in the "Your games" folder:
echo    Love Island.exe - copy to any Windows PC and double-click
echo    Love Island.apk - copy to your phone and tap to install
echo ============================================================
start "" explorer "%CD%\Your games"
pause
exit /b

:fail
echo.
echo Something went wrong above. Copy the text in this window and send it to Claude.
pause
