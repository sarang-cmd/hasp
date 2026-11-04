// The only bridge between the page and the shell.
//
// Context isolation means the page cannot see this file's scope, and sandbox: true
// means this file cannot require anything except electron. What crosses is a
// version string and a lock event, and nothing else.
//
// The page still talks to the vault over loopback with fetch, exactly as it does in
// a browser. This bridge is deliberately not a way to read the vault from
// privileged code.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("haspDesktop", {
  /** Which build this is, for the settings screen. */
  info: () => ipcRenderer.invoke("hasp:info"),

  /** True when the page is running inside the shell rather than a browser tab. */
  isDesktop: true,

  /**
   * Called when the vault process dies or the tray locks it. The page listens so
   * it can show the gate rather than a stale list.
   *
   * `listener` receives one argument, and the returned function unsubscribes, so a
   * page that re-renders does not stack handlers.
   */
  onVaultEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("vault:down", handler);
    ipcRenderer.on("vault:locked", handler);
    return () => {
      ipcRenderer.removeListener("vault:down", handler);
      ipcRenderer.removeListener("vault:locked", handler);
    };
  },
});
