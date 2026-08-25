@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem ============================================================
rem Compress downloaded RJ* work folders and remove them only
rem after the corresponding archive has been created successfully.
rem ============================================================

pushd "%~dp0.."

if errorlevel 1 (
    echo.
    echo ERROR: Cannot open the repository directory.
    echo.
    exit /b 1
)

set "DOWNLOAD_DIR=%CD%\download"
set "ZIP_BAT=%CD%\tools\zip.bat"

if not exist "%DOWNLOAD_DIR%\" (
    echo.
    echo ERROR: Download directory not found:
    echo "%DOWNLOAD_DIR%"
    echo.
    popd
    exit /b 1
)

if not exist "%ZIP_BAT%" (
    echo.
    echo ERROR: Compression script not found:
    echo "%ZIP_BAT%"
    echo.
    popd
    exit /b 1
)

echo.
echo ============================================================
echo Compress downloaded RJ* folders
echo ============================================================
echo.
echo Download directory: "%DOWNLOAD_DIR%"
echo.

set /a AUTHORS=0
set /a WORKS_FOUND=0
set /a WORKS_DELETED=0
set /a FAILED=0

for /f "delims=" %%A in ('dir /b /ad "%DOWNLOAD_DIR%" 2^>nul') do (
    set /a AUTHORS+=1
    call :PROCESS_AUTHOR "%DOWNLOAD_DIR%\%%A"
)

echo.
echo ============================================================
echo Download compression completed
echo ============================================================
echo.
echo Authors found : %AUTHORS%
echo RJ* found     : %WORKS_FOUND%
echo RJ* deleted   : %WORKS_DELETED%
echo Failed authors: %FAILED%
echo.

set "EXIT_CODE=0"

if not "%FAILED%"=="0" (
    set "EXIT_CODE=1"
)

popd
exit /b %EXIT_CODE%


rem ============================================================
rem Compress one author's immediate subfolders, then remove RJ*
rem folders only when the shared compression script succeeded.
rem ============================================================

:PROCESS_AUTHOR

set "AUTHOR_DIR=%~1"
set "AUTHOR_NAME=%~nx1"
set /a AUTHOR_WORKS=0
set /a AUTHOR_DELETED=0

for /f "delims=" %%R in ('dir /b /ad "%AUTHOR_DIR%\RJ*" 2^>nul') do (
    set /a WORKS_FOUND+=1
    set /a AUTHOR_WORKS+=1
)

if "%AUTHOR_WORKS%"=="0" exit /b 0

echo.
echo ------------------------------------------------------------
echo Processing author: "%AUTHOR_NAME%"
echo RJ* folders      : %AUTHOR_WORKS%
echo ------------------------------------------------------------

rem Redirect stdin so the interactive pause in zip.bat cannot block
rem batch processing.
call "%ZIP_BAT%" "%AUTHOR_DIR%" <nul

if errorlevel 1 (
    echo FAILED: Compression failed for "%AUTHOR_NAME%". No RJ* folder was deleted.
    set /a FAILED+=1
    exit /b 1
)

for /f "delims=" %%R in ('dir /b /ad "%AUTHOR_DIR%\RJ*" 2^>nul') do (
    call :DELETE_WORK "%AUTHOR_DIR%\%%R"
    if not errorlevel 1 set /a AUTHOR_DELETED+=1
)

if not "%AUTHOR_DELETED%"=="%AUTHOR_WORKS%" (
    echo FAILED: Not all RJ* folders could be deleted for "%AUTHOR_NAME%".
    set /a FAILED+=1
    exit /b 1
)

echo SUCCESS: Compressed and deleted RJ* folders for "%AUTHOR_NAME%".
exit /b 0


:DELETE_WORK

set "WORK_DIR=%~1"
set "WORK_ARCHIVE=%WORK_DIR%.7z"

if not exist "%WORK_ARCHIVE%" (
    echo FAILED: Expected archive was not created:
    echo "%WORK_ARCHIVE%"
    exit /b 1
)

rd /s /q "%WORK_DIR%" >nul 2>&1

if exist "%WORK_DIR%\" (
    echo FAILED: Cannot delete source folder:
    echo "%WORK_DIR%"
    exit /b 1
)

set /a WORKS_DELETED+=1
exit /b 0
