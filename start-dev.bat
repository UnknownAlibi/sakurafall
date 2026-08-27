@echo off
chcp 65001 >nul 2>&1
title SakuraFall - Dev
cd /d "%~dp0"
npm.cmd run dev
pause
