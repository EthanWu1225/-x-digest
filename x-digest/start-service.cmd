@echo off
REM x-digest service launcher (independent process, survives DSH restarts)
REM Proxy port: change 7897 below if your Clash/V2Ray uses a different port
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
set NODE_USE_ENV_PROXY=1
set "NO_PROXY=api.deepseek.com,dashscope.aliyuncs.com,localhost,127.0.0.1"
cd /d "%~dp0"
node src\cli.mjs --serve


