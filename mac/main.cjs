'use strict';

const { app, BrowserWindow, dialog, Menu, session, shell, ipcMain } = require('electron');
const { createServer } = require('../server.cjs');
const { startOwnedServer, isAppDocumentUrl, isAppResourceUrl, isExternalPageUrl, allowsPermission } = require('./runtime.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { createUpdateNotifications } = require('./updates.cjs');

// Keep the original profile location when upgrading the renamed application.
const legacyProfile = path.join(app.getPath('appData'), 'Channel Room');
if (fs.existsSync(legacyProfile)) app.setPath('userData', legacyProfile);
app.setName('Charliflix');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let player;
  let mainWindow;
  let startup;
  let quitRequested = false;
  let readyToQuit = false;
  let updateNotifications;

  ipcMain.on('charliflix-updater', (event, message) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
        event.senderFrame === mainWindow.webContents.mainFrame && isAppDocumentUrl(event.senderFrame.url, player?.origin)) {
      updateNotifications?.request(message);
    }
  });

  function focusWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function secureSession(ses, origin) {
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || webContents?.getURL();
      callback(allowsPermission(permission, requestingUrl, origin, details.isMainFrame));
    });
    ses.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) =>
      allowsPermission(permission, details.requestingUrl || webContents?.getURL(), origin, details.isMainFrame));
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.resourceType === 'mainFrame'
        ? isAppDocumentUrl(details.url, origin)
        : details.resourceType !== 'subFrame' && isAppResourceUrl(details.url, origin);
      callback({ cancel: !allowed });
    });
  }

  async function createWindow() {
    const win = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 900,
      minHeight: 620,
      title: 'Charliflix',
      backgroundColor: '#101315',
      show: false,
      fullscreenable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
    mainWindow = win;
    win.webContents.setWindowOpenHandler(details => {
      if (isAppDocumentUrl(win.webContents.getURL(), player.origin) && isExternalPageUrl(details.url)) {
        void shell.openExternal(details.url).catch(error => console.error('The approved external page could not open:', error.message));
      }
      return { action: 'deny' };
    });
    const guardDocumentNavigation = event => {
      if (!event.isMainFrame || !isAppDocumentUrl(event.url, player.origin)) event.preventDefault();
    };
    win.webContents.on('will-frame-navigate', guardDocumentNavigation);
    win.webContents.on('will-redirect', guardDocumentNavigation);
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.once('closed', () => { if (mainWindow === win) mainWindow = null; });
    win.webContents.on('did-finish-load', () => updateNotifications?.request({ type: 'charliflix-updater', action: 'status' }));
    await win.loadURL(`${player.origin}/`);
    if (!quitRequested && !win.isDestroyed()) win.show();
    if (player.usedFallbackPort && !quitRequested && !win.isDestroyed()) {
      // Usually the fixed port preserves last-channel, audio, and theater preferences.
      // A separate origin prevents interference with an already running local app.
      void dialog.showMessageBox(win, {
        type: 'info',
        title: 'Charliflix',
        message: 'Another local player is already running.',
        detail: 'Charliflix opened its own connection. Your saved channel and sound settings will return when the usual connection is available next time.',
        buttons: ['OK'],
        noLink: true,
      });
    }
  }

  app.on('second-instance', focusWindow);
  app.on('activate', () => { if (!quitRequested) focusWindow(); });
  // Closing this single-window player also stops its local streaming backend.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (readyToQuit) return;
    event.preventDefault();
    if (quitRequested) return;
    quitRequested = true;
    updateNotifications?.close();
    Promise.resolve(startup).catch(() => {}).then(() => player?.close()).catch(error => {
      console.error('Could not finish closing the local player:', error.message);
    }).finally(() => {
      readyToQuit = true;
      app.quit();
    });
  });

  startup = app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    player = await startOwnedServer({ createServer, root: app.getAppPath() });
    if (quitRequested) return;
    updateNotifications = createUpdateNotifications({ send: data => {
      if (mainWindow && !mainWindow.isDestroyed() && isAppDocumentUrl(mainWindow.webContents.getURL(), player.origin)) {
        mainWindow.webContents.send('charliflix-update-status', data);
      }
    } });
    secureSession(session.defaultSession, player.origin);
    await createWindow();
    updateNotifications.start();
  }).catch(error => {
    if (!quitRequested) dialog.showErrorBox('Charliflix could not start',
      `The local player could not open. Close Charliflix and try again.\n\n${error.message}`);
    app.quit();
  });
}
