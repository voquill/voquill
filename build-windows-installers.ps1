Set-Location 'C:\Users\daveotero\.local\share\opencode\worktree\17951b94037a09926cfe4d0ee16d933c6a5d5efd\Trey-icon-context-menu\apps\desktop'

$log = 'C:\Users\daveotero\.local\share\opencode\worktree\17951b94037a09926cfe4d0ee16d933c6a5d5efd\Trey-icon-context-menu\build-windows-installers.log'
"[$(Get-Date -Format o)] Starting pnpm run tauri build" | Out-File -FilePath $log -Encoding utf8

& pnpm run tauri build *>&1 | Tee-Object -FilePath $log -Append
$exit = $LASTEXITCODE
"[$(Get-Date -Format o)] Exit code: $exit" | Out-File -FilePath $log -Append -Encoding utf8
exit $exit
