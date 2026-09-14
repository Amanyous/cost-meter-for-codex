const { contextBridge, ipcRenderer } = require('electron')

let displayMode = 'inline'

contextBridge.exposeInMainWorld('costMeterBridge', {
  request: (method, params) => ipcRenderer.invoke('cost-meter:bridge', { method, params }),
})

contextBridge.exposeInMainWorld('openai', {
  availableDisplayModes: ['inline', 'fullscreen'],
  getDisplayMode: () => displayMode,
  requestDisplayMode: async ({ mode }) => {
    const result = await ipcRenderer.invoke('cost-meter:display-mode', mode)
    displayMode = result?.mode || displayMode
    return { mode: displayMode }
  },
})
