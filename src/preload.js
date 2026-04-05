const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  lookup: (text) => ipcRenderer.invoke('lookup', text),
  tts: (text) => ipcRenderer.invoke('tts', text),
  closeLookup: () => ipcRenderer.invoke('close-lookup'),
  onNewLookup: (callback) => ipcRenderer.on('new-lookup', (_e, text, scale) => callback(text, scale)),
})
