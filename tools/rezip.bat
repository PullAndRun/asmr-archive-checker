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
rem Temporary extraction directory
rem
rem Default: Windows temporary directory.
rem
rem If you have a RAM disk, you can change it, for example:
rem set "WORK_ROOT=R:\7z_repack_work"
rem ============================================================

set "WORK_ROOT=%TEMP%\7z_repack_work"

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

rem ============================================================
rem Create work root
rem ============================================================

if not exist "%WORK_ROOT%\" (
    md "%WORK_ROOT%" >nul 2>&1
)

if not exist "%WORK_ROOT%\" (
    echo.
    echo ERROR: Cannot create the temporary work directory:
    echo "%WORK_ROOT%"
    echo.
    popd
    pause
    exit /b 1
)

echo.
echo ============================================================
echo Recompress existing 7z archives
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
echo Work directory: "%WORK_ROOT%"
echo.
echo Existing archives will be replaced only after the new
echo archive has been created successfully.
echo.
echo ============================================================
echo.

set /a FOUND=0
set /a SUCCESS=0
set /a FAILED=0
set /a SKIPPED=0

rem ============================================================
rem Take a list of current 7z archives and process them one by one
rem ============================================================

for /f "delims=" %%A in ('dir /b /a-d "*.7z" 2^>nul') do (
    call :CHECK_ARCHIVE "%%~fA"
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
rem Skip temporary or backup archives left by previous runs
rem ============================================================

:CHECK_ARCHIVE

set "ARCHIVE_BASE=%~n1"

if /i "%ARCHIVE_BASE:~-8%"==".__new__" goto :ARCHIVE_SKIPPED
if /i "%ARCHIVE_BASE:~-11%"==".__backup__" goto :ARCHIVE_SKIPPED

set /a FOUND+=1
call :REPACK_ARCHIVE "%~1"
exit /b 0


:ARCHIVE_SKIPPED

set /a SKIPPED+=1
exit /b 0


rem ============================================================
rem Recompress one existing 7z archive
rem ============================================================

:REPACK_ARCHIVE

set "OLD_ARCHIVE=%~1"
set "ARCHIVE_NAME=%~nx1"

rem Example:
rem Old archive : example.7z
rem New archive : example.__new__.7z
rem Backup      : example.__backup__.7z
rem Work folder : example.__repack__

set "NEW_ARCHIVE=%~dpn1.__new__.7z"
set "BACKUP_ARCHIVE=%~dpn1.__backup__.7z"
set "EXTRACT_DIR=%WORK_ROOT%\%~n1.__repack__"

set "OLD_MOVED=0"

echo.
echo ------------------------------------------------------------
echo Processing: "%ARCHIVE_NAME%"
echo ------------------------------------------------------------
echo.

rem ============================================================
rem Basic checks
rem ============================================================

if not exist "%OLD_ARCHIVE%" (
    echo FAILED: The source archive no longer exists.
    goto :REPACK_FAILED
)

if exist "%BACKUP_ARCHIVE%" (
    echo FAILED: A backup archive already exists:
    echo "%BACKUP_ARCHIVE%"
    echo.
    echo Inspect or remove it manually before running again.
    goto :REPACK_FAILED
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
        goto :REPACK_FAILED
    )
)

rem ============================================================
rem Prepare extraction directory
rem ============================================================

if exist "%EXTRACT_DIR%\" (
    echo Removing old extraction directory...
    rd /s /q "%EXTRACT_DIR%" >nul 2>&1
)

if exist "%EXTRACT_DIR%\" (
    echo FAILED: Cannot remove the old extraction directory:
    echo "%EXTRACT_DIR%"
    goto :REPACK_FAILED
)

md "%EXTRACT_DIR%" >nul 2>&1

if not exist "%EXTRACT_DIR%\" (
    echo FAILED: Cannot create the extraction directory:
    echo "%EXTRACT_DIR%"
    goto :REPACK_FAILED
)

rem ============================================================
rem Extract old archive
rem
rem This is required for recompression.
rem It is not a separate "7z t" testing stage.
rem ============================================================

echo Extracting old archive...
echo.

"%SEVENZIP%" x ^
    "%OLD_ARCHIVE%" ^
    -o"%EXTRACT_DIR%" ^
    -aoa ^
    -bsp1 ^
    -y

set "EXTRACT_RC=%ERRORLEVEL%"

if not "%EXTRACT_RC%"=="0" (
    echo.
    echo FAILED: Extraction returned code %EXTRACT_RC%.
    echo The old archive will not be replaced.
    goto :REPACK_FAILED
)

rem ============================================================
rem Recompress extracted contents
rem
rem "*" adds the contents of the extraction directory without
rem adding the temporary extraction directory itself.
rem ============================================================

echo.
echo Creating the new archive...
echo.

pushd "%EXTRACT_DIR%"

if errorlevel 1 (
    echo FAILED: Cannot enter the extraction directory.
    goto :REPACK_FAILED
)

"%SEVENZIP%" a ^
    -t7z ^
    "%NEW_ARCHIVE%" ^
    "*" ^
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

popd

if not "%COMPRESS_RC%"=="0" (
    echo.
    echo FAILED: Compression returned code %COMPRESS_RC%.
    echo The old archive will not be replaced.
    goto :REPACK_FAILED
)

if not exist "%NEW_ARCHIVE%" (
    echo.
    echo FAILED: The new archive was not created.
    goto :REPACK_FAILED
)

rem ============================================================
rem Remove extracted files
rem ============================================================

echo.
echo Removing extracted temporary files...

rd /s /q "%EXTRACT_DIR%" >nul 2>&1

if exist "%EXTRACT_DIR%\" (
    echo WARNING: The new archive was created, but the temporary
    echo extraction directory could not be completely removed:
    echo "%EXTRACT_DIR%"
)

rem ============================================================
rem Rename old archive to backup
rem
rem This is a same-directory rename, not a full file copy.
rem ============================================================

echo.
echo Renaming the old archive to a temporary backup...

move /y "%OLD_ARCHIVE%" "%BACKUP_ARCHIVE%" >nul 2>&1

if errorlevel 1 (
    echo FAILED: Cannot rename the old archive.
    goto :REPACK_FAILED
)

if not exist "%BACKUP_ARCHIVE%" (
    echo FAILED: The backup archive was not created.
    goto :REPACK_FAILED
)

set "OLD_MOVED=1"

rem ============================================================
rem Rename new archive to the original archive name
rem
rem This is also a same-directory rename, not a full file copy.
rem ============================================================

echo Installing the new archive...

move /y "%NEW_ARCHIVE%" "%OLD_ARCHIVE%" >nul 2>&1

if errorlevel 1 (
    echo FAILED: Cannot install the new archive.
    goto :REPACK_FAILED
)

if not exist "%OLD_ARCHIVE%" (
    echo FAILED: The final archive does not exist.
    goto :REPACK_FAILED
)

rem ============================================================
rem Replacement succeeded
rem ============================================================

set "OLD_MOVED=0"

del /f /q "%BACKUP_ARCHIVE%" >nul 2>&1

if exist "%BACKUP_ARCHIVE%" (
    echo.
    echo WARNING: The new archive is installed, but the old backup
    echo could not be deleted:
    echo "%BACKUP_ARCHIVE%"
)

echo.
echo SUCCESS: "%ARCHIVE_NAME%"
echo Archive testing was skipped.

set /a SUCCESS+=1
exit /b 0


rem ============================================================
rem Failure handling
rem ============================================================

:REPACK_FAILED

rem Restore the old archive if it was already renamed to backup.

if not "%OLD_MOVED%"=="1" goto :REPACK_FAILED_CLEANUP

echo.
echo Restoring the original archive...

if exist "%OLD_ARCHIVE%" (
    del /f /q "%OLD_ARCHIVE%" >nul 2>&1
)

if exist "%BACKUP_ARCHIVE%" (
    move /y "%BACKUP_ARCHIVE%" "%OLD_ARCHIVE%" >nul 2>&1
)

if exist "%OLD_ARCHIVE%" (
    echo Original archive restored successfully.
) else (
    echo.
    echo CRITICAL ERROR: Automatic restoration failed.
    echo Check this backup manually:
    echo "%BACKUP_ARCHIVE%"
)


:REPACK_FAILED_CLEANUP

if exist "%NEW_ARCHIVE%" (
    del /f /q "%NEW_ARCHIVE%" >nul 2>&1
)

if exist "%EXTRACT_DIR%\" (
    rd /s /q "%EXTRACT_DIR%" >nul 2>&1
)

echo.
echo FAILED: "%ARCHIVE_NAME%"

set /a FAILED+=1
exit /b 1


rem ============================================================
rem Finish
rem ============================================================

:FINISH

rem Remove the root work directory only if it is empty.

rd "%WORK_ROOT%" >nul 2>&1

echo.
echo ============================================================
echo Recompression completed
echo ============================================================
echo.
echo Archives found : %FOUND%
echo Successful     : %SUCCESS%
echo Failed         : %FAILED%
echo Skipped        : %SKIPPED%
echo Archive testing: Disabled
echo.

if "%FOUND%"=="0" (
    echo No eligible 7z archives were found.
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
