@echo off
rem The `clauding` command on Windows. `bin\` is put in front of every
rem terminal PATH by the app, and Windows only runs .cmd/.exe/.bat from
rem there, so this batch file is what "clauding open ..." actually starts.
rem It hands the very same script bin/clauding to node.
node "%~dp0clauding" %*
