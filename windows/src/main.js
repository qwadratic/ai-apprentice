'use strict';

// Clipa for Windows (preview): a desktop shell around the already-deployed web app. It has no
// features of its own -- no overlay, no screen pipeline, no voice code. It opens one URL, lets
// that one origin ask for the screen and the microphone, and keeps everything else out. See
// ../README.md for what this is and is not.

const path = require('node:path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  session,
  desktopCapturer,
} = require('electron');

// The one page this shell ever loads, and the one origin it ever trusts with the screen or the
// microphone. ALLOWED_PREFIX is stricter than an origin check: it also keeps the window off any
// other project that happens to live under the same qwadratic.github.io origin.
const WEB_APP_URL = 'https://qwadratic.github.io/clipa/';
const ALLOWED_ORIGIN = 'https://qwadratic.github.io';
const ALLOWED_PREFIX = 'https://qwadratic.github.io/clipa/';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

let mainWindow = null;
let tray = null;
let isQuitting = false;

function originOf(urlString) {
  try {
    return new URL(urlString).origin;
  } catch {
    return null;
  }
}

function isAllowedUrl(urlString) {
  return typeof urlString === 'string' && urlString.startsWith(ALLOWED_PREFIX);
}

// Screen share and the microphone are the only two permissions the web app ever asks for, and
// only its own origin may ask. Everything else -- any other site, any other permission -- is
// denied with no prompt, so there is nothing here for an unrelated page to request.
function configurePermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed =
      (permission === 'media' || permission === 'display-capture') &&
      originOf(details.requestingUrl) === ALLOWED_ORIGIN;
    callback(allowed);
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return (
      (permission === 'media' || permission === 'display-capture') &&
      requestingOrigin === ALLOWED_ORIGIN
    );
  });

  // getDisplayMedia() has no browser picker here -- Electron has none built in -- so without this
  // handler the call simply fails. Handing it the first screen source directly is what makes
  // "share the whole screen" work with no extra dialog. There is no window-level picker and no
  // handling of multiple monitors: this preview always offers the first screen desktopCapturer
  // reports, which is usually, but not guaranteed to be, the primary display (see the README).
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const requestOrigin =
      (request.securityOrigin && request.securityOrigin !== 'null' && request.securityOrigin) ||
      originOf(request.frame && request.frame.url);
    if (requestOrigin !== ALLOWED_ORIGIN) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback(sources.length ? { video: sources[0] } : {});
    } catch {
      callback({});
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // No remote code beyond the app's own origin: a link to anywhere else opens in the system
  // browser (if it is http/https) or is just dropped, never loaded into this window or a new one.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) {
      mainWindow.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });

  // Tray-resident app: the window hides instead of closing. The tray's Quit is the only way out
  // (plus the OS killing the process), which is what lets "Show" bring the same session back.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.loadURL(WEB_APP_URL);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('Clipa (Windows preview)');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show',
        click: () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

// Single instance: a second launch (double-clicking the exe again, a second Start Menu click)
// just focuses the window this process already has, instead of opening a second shell.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.hacknation.clipa');
    configurePermissions();
    createWindow();
    createTray();
  });
}
