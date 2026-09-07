Option Explicit
Dim shell, fso, folder, workerPath, exitCode, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
workerPath = folder & "\Codex Companion Worker.vbs"

' Start the registered task so Companion is detached from ChatGPT/Codex and
' no console windows flash at sign-in.
exitCode = shell.Run("schtasks.exe /Run /TN ""\Codex Companion""", 0, True)
If exitCode <> 0 And fso.FileExists(workerPath) Then
    command = "wscript.exe """ & workerPath & """"
    shell.Run command, 0, False
End If
