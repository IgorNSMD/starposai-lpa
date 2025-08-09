const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const cors = require('cors');

const PORT = 9723;
const ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://tu-dominio.netlify.app'];

let mainWin; // opcional, ventana oculta para imprimir

function createHiddenWindow() {
  mainWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

async function printHTMLSilent(html, deviceName, copies = 1) {
  // Crear una ventana efímera por job para aislar estilos
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  for (let i = 0; i < copies; i++) {
    await win.webContents.print({ silent: true, deviceName });
  }
  await win.destroy();
}

function listPrinters() {
  // Necesita una BrowserWindow
  const w = mainWin || BrowserWindow.getAllWindows()[0];
  if (!w) throw new Error('No window available for getPrintersAsync');
  return w.webContents.getPrintersAsync();
}

function setupServer() {
  const appx = express();
  appx.use(express.json({ limit: '2mb' }));
  appx.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, true); // o restringe si prefieres
    }
  }));

  // Seguridad simple opcional por API Key
  appx.use((req, res, next) => {
    const key = req.header('X-API-Key') || '';
    // TODO: valida contra un valor guardado en un archivo config local
    return next();
  });

  appx.get('/health', (req, res) => res.json({ ok: true, version: app.getVersion() }));

  appx.get('/printers', async (req, res) => {
    try {
      const list = await listPrinters();
      res.json(list.map(p => p.name));
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  appx.post('/print', async (req, res) => {
    try {
      const { printerName, html, copies = 1 } = req.body;
      if (!html) return res.status(400).send('html requerido');

      // CSS 80mm base
      const pageCss = `
        <style>
          @media print { @page { size: 80mm auto; margin: 0 } body { width: 80mm; margin:0 } }
          body { font-family: monospace; font-size: 12px; }
        </style>`;

      await printHTMLSilent(`<!doctype html><html><head>${pageCss}</head><body>${html}</body></html>`, printerName, copies);
      res.json({ ok: true });
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  // (Opcional) abrir cajón por ESC/POS si la impresora es de red TCP/9100.
  // appx.post('/open-drawer', async (req, res) => { ... });

  appx.listen(PORT, '127.0.0.1', () => log.info(`LPA listening on http://127.0.0.1:${PORT}`));
}

function setupAutoUpdate() {
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';
  autoUpdater.checkForUpdatesAndNotify();
  autoUpdater.on('update-downloaded', () => {
    // Se aplicará al reiniciar; puedes forzar reinicio:
    // autoUpdater.quitAndInstall();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);    // sin menú
  createHiddenWindow();             // ventana para printers
  setupServer();                    // API local
  setupAutoUpdate();                // auto-update
  app.setLoginItemSettings({ openAtLogin: true }); // arranque con Windows
});

app.on('window-all-closed', (e) => {
  // Mantener residente aunque no haya ventanas
  e.preventDefault();
});
