import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { claudeRunner } from "./claudeCode";
import { cancelSignIn } from "./claudeCode/auth";
import { dockerOrchestrator } from "./dockerOrchestrator";
import { registerIpcHandlers } from "./ipcHandlers";
import { extractBagPathFromArgv } from "./ipcValidation";

// Isolate development environment settings & keychain to prevent permission conflicts
if (!app.isPackaged) {
  app.setName("DataPilot-Dev");
  const userDataPath = join(app.getPath("appData"), "DataPilot-Dev");
  app.setPath("userData", userDataPath);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Enable remote debugging port in development mode so AI agents can inspect the app screen
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch("remote-debugging-port", "8315");
}

// Single-instance lock — second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;

function transitionToFullSize(win: BrowserWindow) {
  const targetWidth = 1440;
  const targetHeight = 940;

  // Enable resizability and set minimum bounds for the main app layout
  win.setResizable(true);
  win.setMinimumSize(1120, 720);

  const [width, height] = win.getSize();
  const [x, y] = win.getPosition();

  // Keep window centered relative to its current screen position
  const newX = Math.round(x + (width - targetWidth) / 2);
  const newY = Math.round(y + (height - targetHeight) / 2);

  // Instantly update bounds (centered and resized)
  win.setBounds({ x: newX, y: newY, width: targetWidth, height: targetHeight });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 580,
    height: 300,
    minWidth: 580,
    minHeight: 300,
    resizable: false, // Start locked during setup
    icon: join(__dirname, "../../build/icon.png"),
    show: false,
    backgroundColor: "#15171b", // Match --bg-0
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" && {
      trafficLightPosition: { x: 12, y: 12 },
    }),
    titleBarOverlay:
      process.platform === "win32"
        ? { color: "#15171b", symbolColor: "#9aa3ad", height: 36 }
        : false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Dev: load from Vite dev server; Prod: load packaged index.html.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("second-instance", (_event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();

    // #51: forward a bag path from the second instance's argv so that
    // "Open with DataPilot" works on an already-running app instead of
    // silently doing nothing.
    const bagPath = extractBagPathFromArgv(commandLine);
    if (bagPath) {
      mainWindow.webContents.send("file:open-bag", bagPath);
    }
  }
});

let isQuitting = false;

app.on("before-quit", (e) => {
  if (!isQuitting) {
    e.preventDefault();
    isQuitting = true;
    // Stop Claude Code runs and any sign-in first, so no child outlives the app.
    claudeRunner.killAll();
    cancelSignIn();
    console.log("Teardown triggered. Cleaning up Docker stack...");
    dockerOrchestrator
      .ensureStackDown()
      .then(() => {
        console.log("Cleanup completed. Exiting.");
        app.quit();
      })
      .catch((err) => {
        console.error("Teardown failed:", err);
        app.quit();
      });
  }
});

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  // Listen for docker status ready to expand the window
  const unsubscribe = dockerOrchestrator.onStatusChange((status) => {
    if (status.state === "ready") {
      if (mainWindow) {
        transitionToFullSize(mainWindow);
      }
      unsubscribe();
    }
  });

  if (dockerOrchestrator.getStatus().state === "ready") {
    if (mainWindow) {
      transitionToFullSize(mainWindow);
    }
    unsubscribe();
  }

  // Spin up Docker containers in the background on startup
  void dockerOrchestrator.ensureStackUp();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
