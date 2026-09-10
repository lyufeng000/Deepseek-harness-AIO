; DSH Desktop (Tauri) NSIS installer hooks —— 自 build/installer.nsh（Electron 版）
; 移植的实战逻辑，按 Tauri v2 的四个钩子点重组：
;
;   NSIS_HOOK_PREINSTALL    运行中进程清理（本代+三代旧版）→ 有界等待放行 → 旧快捷方式清理
;   NSIS_HOOK_POSTINSTALL   （空）
;   NSIS_HOOK_PREUNINSTALL  再杀一次进程（静默卸载时应用可能仍在跑）→ 用户数据删除询问（默认保留）
;
; 与 Electron 版的差异（有意为之，勿"补回"）：
;   · 不接管其他产品目录；AIO 只清自己的 $INSTDIR\resources。Tauri 默认
;     卸载在深 node_modules 上会静默残留，故用 robocopy 空镜像兜底。
;   · 卸载询问只清 AIO identifier 对应的数据目录（其中包含 AIO 自有 dsh-home）；
;     绝不动 Electron/v4Lite 版数据——多产品可在同一台机器并存。
;   · 全程无 cmd 管道 / find / nsProcess（v4.2 教训：nsExec 在无控制台上下文
;     管道读取偶发永不返回；electron-builder 自带 NSIS 加载不了 nsProcess）。
;     探测用 nsExec 直接 CreateProcess 的 tasklist /FI CSV /NH，首字符判断。

; Resolve the stop helper relative to this hook file at include time. Inside a
; macro ${__FILEDIR__} expands to Tauri's generated installer directory, so the
; path must be frozen into a define at the top level (staging mirrors assets/**
; into resources/app/assets/**).
!define AIO_UPDATE_STOP_PS1 "${__FILEDIR__}\..\resources\app\assets\update\stop-installed.ps1"

!macro _dshKillAll
  ; The AIO build has a distinct process name and never terminates the user's
  ; currently running v4Lite or any earlier EAC installation.
  InitPluginsDir
  File /oname=$PLUGINSDIR\aio-stop-installed.ps1 "${AIO_UPDATE_STOP_PS1}"
  System::Call 'kernel32::SetEnvironmentVariable(t "AIO_TARGET_ROOT", t "$INSTDIR") i.r0'
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\aio-stop-installed.ps1"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法安全停止此安装目录的进程，操作已中止。请退出应用后重试。" /SD IDOK
    Abort
  ${EndIf}
!macroend

; 有界等待本代进程退场（最多 20 × 500ms ≈ 10s，超时放行不卡死安装）。
; 无管道：tasklist /FI 按映像名精确过滤 + /FO CSV /NH，进程存在时输出首字符
; 必为双引号，与系统语言无关。
!macro _dshWaitCurrentExits
  StrCpy $1 0
  dshWaitLoop:
    IntOp $1 $1 + 1
    ${If} $1 > 20
      MessageBox MB_OK|MB_ICONSTOP "DSHEAC AIO 仍在运行，安装已中止。请先退出程序后重试。" /SD IDOK
      Abort
    ${EndIf}
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\aio-stop-installed.ps1" -CheckOnly'
    Pop $3
    Pop $0
    ${If} $3 != 0
      Sleep 500
      Goto dshWaitLoop
    ${EndIf}
  dshWaitDone:
!macroend

; 尽力删除一个目录；深层 node_modules 超 MAX_PATH 时用 robocopy 镜像空目录兜底
; （robocopy 原生支持 >260 字符路径）。
!macro dshWipeDir target
  ClearErrors
  RMDir /r "${target}"
  ${If} ${FileExists} "${target}"
    RMDir /r "$TEMP\dsh-aio-empty-wipe"
    CreateDirectory "$TEMP\dsh-aio-empty-wipe"
    nsExec::Exec 'robocopy "$TEMP\dsh-aio-empty-wipe" "${target}" /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1'
    Pop $0
    RMDir /r "${target}"
    RMDir /r "$TEMP\dsh-aio-empty-wipe"
  ${EndIf}
  ${If} ${FileExists} "${target}"
    MessageBox MB_OK|MB_ICONSTOP "无法清理 ${target}。请关闭占用该目录的程序后重试。" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; NSIS 7z payload extraction still loses very deep node_modules files when
  ; the user-selected root is excessively long. Fail before writing a partial
  ; installation. 120 root characters leaves margin for the shipped max path.
  StrLen $0 "$INSTDIR"
  ${If} $0 > 120
    MessageBox MB_OK|MB_ICONSTOP "安装路径过长，可能导致依赖文件缺失。请改用更短路径（建议不超过 120 个字符）。" /SD IDOK
    Abort
  ${EndIf}
  !insertmacro _dshKillAll
  !insertmacro _dshWaitCurrentExits

!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 先确保没有残留进程占用安装文件，再用长路径安全方式清理 payload。
  !insertmacro _dshKillAll
  !insertmacro dshWipeDir "$INSTDIR\resources"

  ; 卸载完成前询问是否同时删除用户数据；默认「否」（保留）——
  ; 重装后设置与会话历史原样恢复。
  ; 删除范围仅限 AIO 发行版自有数据。静默卸载默认保留用户数据。
  IfSilent dshUnKeep
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "是否同时删除 DSHEAC AIO v1 用户数据？$\r$\n$\r$\n当前运行的 v4Lite 数据不会受到影响。" \
    IDYES dshUnWipe IDNO dshUnKeep
  Goto dshUnKeep
  dshUnWipe:
    !insertmacro dshWipeDir "$APPDATA\com.deepseek.dsh.desktop.aio"
  dshUnKeep:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
