@echo off
setlocal
set "HERE=%~dp0.."
set "PROJ="
for /d %%d in ("%USERPROFILE%\AndroidStudioProjects\*") do (
  if not defined PROJ if exist "%%~d\app\src\main\java\com\loveisland\player\MainActivity.java" set "PROJ=%%~d"
)
if not defined PROJ (
  echo   Skipped: no Android Studio project for the phone app was found.
  echo   Create it once with android\STEPS.txt, then run BUILD.bat again.
  exit /b 0
)
echo   Using project: %PROJ%
set "JBR="
for %%j in ("%ProgramFiles%\Android\Android Studio\jbr" "%LOCALAPPDATA%\Programs\Android Studio\jbr") do (
  if not defined JBR if exist "%%~j\bin\java.exe" set "JBR=%%~j"
)
if defined JBR set "JAVA_HOME=%JBR%"
copy /y "%HERE%\android\MainActivity.java" "%PROJ%\app\src\main\java\com\loveisland\player\MainActivity.java" >nul
rem App icon: replace Android's default robot with the Love Island picture
set "RES=%PROJ%\app\src\main\res"
for /d %%m in ("%RES%\mipmap-*") do del /q "%%~m\ic_launcher.*" "%%~m\ic_launcher_round.*" 2>nul
robocopy "%HERE%\android\icon" "%RES%" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%HERE%\player" "%PROJ%\app\src\main\assets\player" /MIR /NFL /NDL /NJH /NJS /NP >nul
robocopy "%HERE%\data" "%PROJ%\app\src\main\assets\data" /MIR /XF *.wav *.part *.tmp /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo   Copying the game into the project failed.
  exit /b 0
)
pushd "%PROJ%"
call gradlew.bat assembleDebug --console=plain -q
set "ERR=%errorlevel%"
popd
if not "%ERR%"=="0" (
  echo   The phone app build failed. Send the text above to Claude,
  echo   or open the project in Android Studio and use Build, then Build APKs.
  exit /b 0
)
copy /y "%PROJ%\app\build\outputs\apk\debug\app-debug.apk" "%HERE%\Your games\Love Island.apk" >nul
echo   Built: Your games\Love Island.apk
exit /b 0
