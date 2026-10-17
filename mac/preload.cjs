'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('charliflixUpdates', {
  postMessage(message) {
    if (message?.type === 'charliflix-updater' && ['status', 'check'].includes(message.action)) {
      ipcRenderer.send('charliflix-updater', { type: 'charliflix-updater', action: message.action });
    }
  },
  onMessage(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('charliflix-update-status', (_event, data) => callback({ data }));
  },
});
