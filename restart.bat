@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "%~dp0stop.bat" /nopause
call "%~dp0start.bat"
