// Start at login on Linux: an XDG autostart entry (Electron's login items cover Mac and Windows).

import { join } from 'node:path'

export const AUTOSTART_NAME = 'dev.afterhours.app.desktop'

export function autostartPath(home: string, xdgConfigHome = process.env.XDG_CONFIG_HOME): string {
  return join(xdgConfigHome || join(home, '.config'), 'autostart', AUTOSTART_NAME)
}

/** Quotes a path for a .desktop file's Exec line. */
function quote(path: string): string {
  return `"${path.replace(/(["`$\\])/g, '\\$1')}"`
}

/** `executable`: the AppImage when run from one ($APPIMAGE), else the app's own binary. */
export function autostartEntry(executable: string): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Afterhours', 'Comment=Your machines’ Claude Code queues', `Exec=${quote(executable)} --hidden`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n')
}
