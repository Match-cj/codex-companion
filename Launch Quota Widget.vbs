Option Explicit
Dim shell, fso, folder, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = folder & "\Quota Widget WPF.ps1"
command = "powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""$source=Get-Content -Raw -Encoding UTF8 -LiteralPath '" & Replace(scriptPath, "'", "''") & "'; & ([ScriptBlock]::Create($source))"""
shell.Run command, 0, False
