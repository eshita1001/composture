const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  session,
  systemPreferences,
  ipcMain,
  powerSaveBlocker,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");

let history = [];          // past sessions (most recent first)
let shrimpVisible = true;  // reflects the "Show shrimp" menu checkbox
let settings = { soundOn: true }; // persisted app settings

// Keep the renderer (and posture detection) running full-speed even when the
// window is unfocused / in the background. Must be set before app is ready.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// The big one on macOS: stop Chromium marking the unfocused widget "occluded".
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let win = null;
let tray = null;
let historyWin = null; // the session-history window
let dragOffset = null; // used while dragging the shrimp around

// compact when idle (just the shrimp), expands on hover to reveal the panels
const SMALL_W = 260, SMALL_H = 250;
const BIG_W = 480, BIG_H = 310;
let shrinkTimer = null;

function createWindow() {
  // Start compact (just the shrimp); it expands on hover.
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(workArea.x + (workArea.width - SMALL_W) / 2);
  const y = workArea.y + 8;

  win = new BrowserWindow({
    width: SMALL_W,
    height: SMALL_H,
    x,
    y,
    frame: false,          // no title bar / borders
    transparent: true,     // see-through background (no box)
    resizable: true,       // we resize it programmatically on hover
    hasShadow: false,      // no drop shadow box
    alwaysOnTop: true,     // floats over other apps
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false, // keep tracking when hidden / in background
    },
  });

  // Keep it floating above normal windows, and visible even in fullscreen apps.
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Belt-and-suspenders: never throttle this renderer in the background.
  win.webContents.setBackgroundThrottling(false);

  win.loadFile("index.html");

  // tell the renderer the saved sound preference once it's ready
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("set-sound", settings.soundOn);
  });
}

// ---- session history persistence ----
function historyFile() {
  return path.join(app.getPath("userData"), "sessions.json");
}
function loadHistory() {
  try {
    history = JSON.parse(fs.readFileSync(historyFile(), "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch (e) {
    history = [];
  }
}
function saveHistory() {
  try {
    fs.writeFileSync(historyFile(), JSON.stringify(history));
  } catch (e) {}
}
function fmtDur(ms) {
  let s = Math.floor(ms / 1000);
  let m = Math.floor(s / 60);
  s = s % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), "utf8")));
  } catch (e) {}
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch (e) {}
}

function showAbout() {
  dialog.showMessageBox({
    type: "info",
    title: "About Composture",
    message: "Composture  🦐",
    detail:
      "A posture-detection desktop buddy.\n" +
      "Sit up straight, or you'll cook him.\n\n" +
      "Made by Eshita Akella\n" +
      "Version " + app.getVersion() + "\n" +
      "Uses your webcam locally (ml5.js BodyPose) — nothing leaves your Mac.",
    buttons: ["OK"],
  });
}

function openHistoryWindow() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show();
    historyWin.focus();
    return;
  }
  historyWin = new BrowserWindow({
    width: 460,
    height: 600,
    title: "Composture — Sessions",
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  historyWin.loadFile("history.html");
  historyWin.on("closed", () => {
    historyWin = null;
  });
}

function refreshHistoryWindow() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.webContents.send("history-data", history);
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Show shrimp",
      type: "checkbox",
      checked: shrimpVisible,
      click: (item) => {
        shrimpVisible = item.checked;
        if (!win) return;
        if (item.checked) win.show();
        else win.hide(); // stays hidden but keeps tracking in the background
      },
    },
    {
      label: "Sound",
      type: "checkbox",
      checked: settings.soundOn,
      click: (item) => {
        settings.soundOn = item.checked;
        saveSettings();
        if (win) win.webContents.send("set-sound", settings.soundOn);
      },
    },
    {
      label: "Recalibrate posture",
      click: () => {
        if (win) win.webContents.send("recalibrate");
      },
    },
    { type: "separator" },
    { label: "Session history…", click: () => openHistoryWindow() },
    { type: "separator" },
    { label: "About Composture", click: () => showAbout() },
    { label: "Quit Composture", click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, "shrimp1.png"))
    .resize({ width: 18, height: 18 });

  tray = new Tray(icon);
  tray.setToolTip("Composture");
  tray.setContextMenu(buildTrayMenu());
}

// Record a finished session and refresh the menu.
function recordSession(summary) {
  history.unshift({
    date: Date.now(),
    durationMs: summary.durationMs || 0,
    cookedCount: summary.cookedCount || 0,
    bestAliveMs: summary.bestAliveMs || 0,
  });
  if (history.length > 100) history = history.slice(0, 100);
  saveHistory();
  if (tray) tray.setContextMenu(buildTrayMenu());
  refreshHistoryWindow();
}

// Move the window as the user drags the shrimp. The renderer just tells us
// "drag started / dragging / ended"; we read the real cursor position here.
function setupDragHandlers() {
  ipcMain.on("drag-start", () => {
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    dragOffset = { x: p.x - wx, y: p.y - wy };
  });
  ipcMain.on("drag-move", () => {
    if (!win || !dragOffset) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
  });
  ipcMain.on("drag-end", () => {
    dragOffset = null;
  });
}

// Grow on hover / shrink when the mouse leaves — anchored to the window's
// top-right corner so the shrimp stays put while the panels appear to its left.
function setExpanded(expanded) {
  if (!win) return;
  const b = win.getBounds();
  const rightX = b.x + b.width;
  const topY = b.y;
  const w = expanded ? BIG_W : SMALL_W;
  const h = expanded ? BIG_H : SMALL_H;
  win.setBounds({ x: rightX - w, y: topY, width: w, height: h });
}

let liveSession = null; // latest snapshot of an in-progress session

function setupSessionHistory() {
  ipcMain.on("session-ended", (e, summary) => {
    liveSession = null; // it's being recorded now; don't double-log on quit
    recordSession(summary || {});
  });
  // the renderer sends periodic snapshots while a session is running
  ipcMain.on("session-active", (e, summary) => {
    liveSession = summary || null;
  });
  ipcMain.on("session-cleared", () => {
    liveSession = null;
  });

  // history window asks for data once it has loaded
  ipcMain.on("history-ready", (e) => {
    e.sender.send("history-data", history);
  });
  // clear button inside the history window
  ipcMain.on("clear-history", () => {
    history = [];
    saveHistory();
    if (tray) tray.setContextMenu(buildTrayMenu());
    refreshHistoryWindow();
  });
}

function setupHoverResize() {
  ipcMain.on("set-hover", (e, expanded) => {
    if (expanded) {
      if (shrinkTimer) {
        clearTimeout(shrinkTimer);
        shrinkTimer = null;
      }
      setExpanded(true);
    } else {
      if (shrinkTimer) clearTimeout(shrinkTimer);
      // small delay so brushing past an edge doesn't cause flicker
      shrinkTimer = setTimeout(() => {
        setExpanded(false);
        shrinkTimer = null;
      }, 180);
    }
  });
}

app.whenReady().then(async () => {
  // Menu bar app: no dock icon.
  if (app.dock) app.dock.hide();

  // Always load the latest HTML/JS/CSS on launch (avoid stale cached UI).
  try {
    await session.defaultSession.clearCache();
  } catch (e) {}

  // Auto-approve the page's own getUserMedia() camera request.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    if (permission === "media") return cb(true);
    cb(false);
  });

  // Show the shrimp + menu bar icon right away (don't wait on the camera).
  // Stop macOS App Nap from suspending us when we're not the frontmost app.
  try {
    powerSaveBlocker.start("prevent-app-suspension");
  } catch (e) {}

  loadHistory();
  loadSettings();
  createWindow();
  createTray();
  setupDragHandlers();
  setupHoverResize();
  setupSessionHistory();

  // Drive posture detection from here — Node timers keep firing at full rate
  // even when the window is unfocused / in the background, unlike the renderer.
  setInterval(() => {
    if (win && !win.isDestroyed()) win.webContents.send("tick");
  }, 70);

  // Ask macOS for camera access in the background (triggers the system prompt).
  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("camera").catch(() => {});
  }
});

// If a session is still running when the app quits, record it too.
app.on("before-quit", () => {
  if (liveSession) {
    recordSession(liveSession);
    liveSession = null;
  }
});

// Don't quit when the window "closes" — this lives in the menu bar.
app.on("window-all-closed", () => {
  // Intentionally do nothing; quit only from the tray menu.
});
