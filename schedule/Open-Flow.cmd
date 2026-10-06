@echo off
rem Opens Google Flow in a new Chrome window. Edit the URL to point at a project for Upscaled mode.
rem Add --profile-directory="Profile 2" after --new-window if Flow is signed in under a non-default Chrome profile.
set URL=https://flow.google.com/
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
start "" "%CHROME%" --new-window "%URL%"
