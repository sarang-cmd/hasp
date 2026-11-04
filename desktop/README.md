# Desktop shell

The desktop app is a window around the server you already have. It does not
reimplement the vault. It starts the same `server.mjs`, waits for it to listen, and
loads the same pages.

Run it from the repository:

    npm install
    npm run desktop

## What the shell adds

- A real window with no address bar. A vault in a browser tab can be phished by a
  page that looks like it. A window with a fixed origin cannot.
- A global shortcut, `CommandOrControl+Shift+H`, which summons the window from any
  application.
- A tray item, so the vault keeps running when the window is closed, and one click
  locks it when you walk away.
- A vault directory in the application data directory rather than in whatever
  folder a terminal happened to be in.

## Where the vault lives

| Build | Path |
| --- | --- |
| Development | `.vault/` in the repository |
| Packaged | `<user data>/vault`, which is `~/Library/Application Support/Hasp` on macOS, `%APPDATA%\Hasp` on Windows and `~/.config/Hasp` on Linux |

Override it with `HASP_VAULT_DIR` if you keep the vault somewhere specific, such as
an encrypted disk image.

The packaged path matters. An install directory is read only on macOS and is
replaced on update everywhere else, so a vault stored next to the binary is lost at
the next release.

## What the renderer can reach

Nothing privileged. `nodeIntegration` is off, `contextIsolation` and `sandbox` are
on, and the preload exposes one function, which returns a version string, and one
subscription, which reports that the vault went down or was locked.

The page talks to the vault over loopback with `fetch`, exactly as it does in a
browser. There is no IPC route into the vault key, because there is no reason for
one. A page that is compromised inside this window is exactly as powerful as a
compromised browser tab, which is the point.

## Signing and stores

Not done, and not pretended otherwise. Shipping this needs:

- An Apple Developer certificate for signing and notarising the macOS build.
- A code signing certificate for Windows, or an MSIX for the Microsoft Store.
- Auto update, which needs a release server and a signature per platform.

None of those are code, and each of them costs money or paperwork. The app runs
unsigned from source today.
