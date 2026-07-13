@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0create-local-certs.ps1" %*
