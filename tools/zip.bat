@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem ============================================================
rem Compression settings
rem
rem 64 GB RAM:
rem 7-Zip memory target = 51 GB
rem About 13 GB is reserved for Windows and other programs.
rem ============================================================

set "MEM_LIMIT=51g"
set "DICT_SIZE=512m"

rem ============================================================
rem Locate 7-Zip
rem ============================================================

call :FIND_7ZIP

if not defined SEVENZIP (
    echo.
    echo ERROR: 7z.exe was not found.
    echo Please install the 64-bit version of 7-Zip.
    echo.
    pause
    exit /b 1
)

rem ============================================================
rem Use the BAT file directory
rem ============================================================

pushd "%~dp0"

if errorlevel 1 (
    echo.
    echo ERROR: Cannot open the BAT file directory.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo Compress each first-level folder separately
echo ============================================================
echo.
echo Memory target : %MEM_LIMIT%
echo Dictionary    : %DICT_SIZE%
echo Method        : LZMA2
echo Level         : Ultra
echo Solid mode    : Enabled
echo Sort by type  : Enabled
echo Threads       : Automatic
echo Archive test  : Disabled
echo.
echo Source folders will not be deleted.
echo Existing archives will be replaced only after the new
echo archive has been created successfully.
echo.
echo ============================================================
echo.

set /a FOUND=0
set /a SUCCESS=0
set /a FAILED=0

rem ============================================================
rem Process every immediate subfolder
rem ============================================================

for /f "delims=" %%D in ('dir /b /ad 2^>nul') do (
    set /a FOUND+=1
    call :COMPRESS_FOLDER "%%~fD"
)

goto :FINISH


rem ============================================================
rem Locate 7z.exe
rem ============================================================

:FIND_7ZIP

set "SEVENZIP="

if exist "%ProgramFiles%\7-Zip\7z.exe" (
    set "SEVENZIP=%ProgramFiles%\7-Zip\7z.exe"
    exit /b 0
)

if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" (
    set "SEVENZIP=%ProgramFiles(x86)%\7-Zip\7z.exe"
    exit /b 0
)

where 7z.exe >nul 2>&1

if not errorlevel 1 (
    set "SEVENZIP=7z.exe"
)

exit /b 0


rem ============================================================
rem Compress one first-level folder
rem ============================================================

:COMPRESS_FOLDER

set "SOURCE_FOLDER=%~1"
set "FOLDER_NAME=%~nx1"

rem Example:
rem Source  : Folder_A
rem Final   : Folder_A.7z
rem New     : Folder_A.__new__.7z
rem Backup  : Folder_A.__backup__.7z

set "FINAL_ARCHIVE=%~1.7z"
set "NEW_ARCHIVE=%~1.__new__.7z"
set "BACKUP_ARCHIVE=%~1.__backup__.7z"

set "OLD_MOVED=0"

echo.
echo ------------------------------------------------------------
echo Processing folder: "%FOLDER_NAME%"
echo Output archive   : "%FOLDER_NAME%.7z"
echo ------------------------------------------------------------
echo.

rem ============================================================
rem Basic checks
rem ============================================================

if not exist "%SOURCE_FOLDER%\" (
    echo FAILED: The source folder no longer exists.
    goto :FOLDER_FAILED
)

if exist "%BACKUP_ARCHIVE%" (
    echo FAILED: A backup archive already exists:
    echo "%BACKUP_ARCHIVE%"
    echo.
    echo Inspect or remove it manually before running again.
    goto :FOLDER_FAILED
)

rem ============================================================
rem Remove stale new archive
rem ============================================================

if exist "%NEW_ARCHIVE%" (
    echo Removing old temporary archive...

    del /f /q "%NEW_ARCHIVE%" >nul 2>&1

    if exist "%NEW_ARCHIVE%" (
        echo FAILED: Cannot remove:
        echo "%NEW_ARCHIVE%"
        goto :FOLDER_FAILED
    )
)

rem ============================================================
rem Create the new archive
rem
rem FOLDER_NAME is added from the BAT directory, so the archive
rem retains the top-level folder itself.
rem
rem There is intentionally no "7z t" command.
rem ============================================================

echo Compressing...
echo.

"%SEVENZIP%" a ^
    -t7z ^
    "%NEW_ARCHIVE%" ^
    "%FOLDER_NAME%" ^
    -m0=LZMA2 ^
    -mx=9 ^
    -md=%DICT_SIZE% ^
    -mfb=273 ^
    -ms=on ^
    -mqs ^
    -mmemuse=%MEM_LIMIT% ^
    -bsp1 ^
    -y

set "COMPRESS_RC=%ERRORLEVEL%"

if not "%COMPRESS_RC%"=="0" (
    echo.
    echo FAILED: Compression returned code %COMPRESS_RC%.
    goto :FOLDER_FAILED
)

if not exist "%NEW_ARCHIVE%" (
    echo.
    echo FAILED: The new archive was not created.
    goto :FOLDER_FAILED
)

rem ============================================================
rem Rename old archive to backup
rem
rem Same-directory rename; the archive is not copied.
rem ============================================================

if exist "%FINAL_ARCHIVE%" (
    echo.
    echo Renaming the existing archive to a temporary backup...

    move /y "%FINAL_ARCHIVE%" "%BACKUP_ARCHIVE%" >nul 2>&1

    if errorlevel 1 (
        echo FAILED: Cannot rename the existing archive.
        goto :FOLDER_FAILED
    )

    if not exist "%BACKUP_ARCHIVE%" (
        echo FAILED: The backup archive was not created.
        goto :FOLDER_FAILED
    )

    set "OLD_MOVED=1"
)

rem ============================================================
rem Rename new archive to final archive
rem
rem Same-directory rename; the archive is not copied.
rem ============================================================

echo Installing the new archive...

move /y "%NEW_ARCHIVE%" "%FINAL_ARCHIVE%" >nul 2>&1

if errorlevel 1 (
    echo FAILED: Cannot install the new archive.
    goto :FOLDER_FAILED
)

if not exist "%FINAL_ARCHIVE%" (
    echo FAILED: The final archive does not exist.
    goto :FOLDER_FAILED
)

rem ============================================================
rem Replacement succeeded
rem ============================================================

set "OLD_MOVED=0"

if exist "%BACKUP_ARCHIVE%" (
    del /f /q "%BACKUP_ARCHIVE%" >nul 2>&1

    if exist "%BACKUP_ARCHIVE%" (
        echo.
        echo WARNING: The new archive is installed, but the old
        echo backup could not be deleted:
        echo "%BACKUP_ARCHIVE%"
    )
)

echo.
echo SUCCESS: "%FOLDER_NAME%.7z"
echo Archive testing was skipped.

set /a SUCCESS+=1
exit /b 0


rem ============================================================
rem Failure handling
rem ============================================================

:FOLDER_FAILED

rem Restore the previous archive if it was already renamed.

if not "%OLD_MOVED%"=="1" goto :FOLDER_FAILED_CLEANUP

echo.
echo Restoring the previous archive...

if exist "%FINAL_ARCHIVE%" (
    del /f /q "%FINAL_ARCHIVE%" >nul 2>&1
)

if exist "%BACKUP_ARCHIVE%" (
    move /y "%BACKUP_ARCHIVE%" "%FINAL_ARCHIVE%" >nul 2>&1
)

if exist "%FINAL_ARCHIVE%" (
    echo Previous archive restored successfully.
) else (
    echo.
    echo CRITICAL ERROR: Automatic restoration failed.
    echo Check this backup manually:
    echo "%BACKUP_ARCHIVE%"
)


:FOLDER_FAILED_CLEANUP

if exist "%NEW_ARCHIVE%" (
    del /f /q "%NEW_ARCHIVE%" >nul 2>&1
)

echo.
echo FAILED: "%FOLDER_NAME%"

set /a FAILED+=1
exit /b 1


rem ============================================================
rem Finish
rem ============================================================

:FINISH

echo.
echo ============================================================
echo Folder compression completed
echo ============================================================
echo.
echo Folders found  : %FOUND%
echo Successful     : %SUCCESS%
echo Failed         : %FAILED%
echo Archive testing: Disabled
echo.

if "%FOUND%"=="0" (
    echo No first-level folders were found.
    echo.
)

set "EXIT_CODE=0"

if not "%FAILED%"=="0" (
    set "EXIT_CODE=1"
)

popd

echo Press any key to close this window.
pause >nul

endlocal & exit /b %EXIT_CODE%
