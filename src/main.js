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

// --- NUEVO: asegurar una ventana para getPrintersAsync
function ensureWindow() {
  let w = mainWin || BrowserWindow.getAllWindows()[0];
  if (!w) {
    w = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  }
  return w;
}

// --- NUEVO: extraer info de papel desde options del driver (best effort)
function extractPaperInfoFromOptions(opts = {}) {
  const out = {
    from: [],
    rawKeys: Object.keys(opts || {}),
  };

  if (Array.isArray(opts.papers)) {
    for (const p of opts.papers) {
      const name = String(p?.name ?? p?.displayName ?? '').trim();
      const width = Number(p?.width ?? p?.w ?? p?.mmWidth ?? p?.sizeX ?? NaN);
      const height = Number(p?.height ?? p?.h ?? p?.mmHeight ?? p?.sizeY ?? NaN);
      out.from.push({
        name,
        widthMm: Number.isFinite(width) ? width : null,
        heightMm: Number.isFinite(height) ? height : null,
      });
    }
  }

  const ms = opts.mediaSize || opts.paperSize || opts.size;
  if (ms && (ms.width || ms.height)) {
    out.from.push({
      name: 'mediaSize',
      width: ms.width ?? null,
      height: ms.height ?? null,
      units: ms.unit ?? 'unknown',
    });
  }

  const maybeSizeStrings = []
    .concat(opts.pageSize || [])
    .concat(opts.media || [])
    .concat(opts.customPaperSize || [])
    .concat(opts.paper || []);

  for (const entry of maybeSizeStrings) {
    if (!entry) continue;
    const s = String(entry);
    const mmMatch = s.match(/(\d+(?:\.\d+)?)\s*mm/i);
    if (mmMatch) {
      out.from.push({ name: s, widthMm: Number(mmMatch[1]) });
    } else {
      out.from.push({ name: s });
    }
  }

  return out;
}

// --- NUEVO: estimar ancho del rollo térmico (58/80mm) por nombre/opciones
function guessThermalWidthMm(printerName, paperInfo) {
  const name = (printerName || '').toLowerCase();
  if (name.includes('80') || name.includes('t20') || name.includes('tm-t20') || name.includes('t88')) return 80;
  if (name.includes('58')) return 58;

  for (const p of paperInfo.from) {
    const ns = (p.name || '').toLowerCase();
    if (ns.includes('80mm') || ns.includes('80 mm')) return 80;
    if (ns.includes('58mm') || ns.includes('58 mm')) return 58;

    if (p.widthMm && p.widthMm >= 75 && p.widthMm <= 85) return 80;
    if (p.widthMm && p.widthMm >= 55 && p.widthMm <= 60) return 58;
  }
  return 80; // default más común
}

async function printHTMLSilent(html, deviceName, copies = 1) {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  for (let i = 0; i < copies; i++) {
    await win.webContents.print({ silent: true, deviceName });
  }
  await win.destroy();
}

function listPrinters() {
  const w = ensureWindow();
  return w.webContents.getPrintersAsync();
}

function setupServer() {
  const appx = express();
  appx.use(express.json({ limit: '2mb' }));
  appx.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, true); // restringe aquí si quieres
    }
  }));

  // Seguridad simple opcional por API Key
  appx.use((req, res, next) => {
    const key = req.header('X-API-Key') || '';
    // TODO: valida contra un valor guardado en un archivo config local
    return next();
  });

  // --- EXISTENTES
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

      const pageCss = `
        <style>
          @media print { @page { size: 80mm auto; margin: 0 } body { width: 80mm; margin:0 } }
          body { font-family: monospace; font-size: 12px; }
        </style>`;

      await printHTMLSilent(
        `<!doctype html><html><head>${pageCss}</head><body>${html}</body></html>`,
        printerName,
        copies
      );
      res.json({ ok: true });
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  // --- NUEVOS ENDPOINTS

  // Dump completo de impresoras (para depurar drivers/opciones)
  appx.get('/printers/detail', async (req, res) => {
    try {
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();
      res.json(printers);
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  // Impresora por defecto + info de papel y ancho estimado
  appx.get('/default-printer', async (req, res) => {
    try {
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();
      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ error: 'No printers found' });
      }

      const def = printers.find(p => p.isDefault) || printers[0];
      const paperInfo = extractPaperInfoFromOptions(def.options || {});
      const guessWidthMm = guessThermalWidthMm(def.name, paperInfo);

      let reportedWidthMm = null;
      let reportedHeightMm = null;
      const candidate = paperInfo.from.find(p => typeof p.widthMm === 'number' || (p.width && p.height));
      if (candidate) {
        if (typeof candidate.widthMm === 'number') {
          reportedWidthMm = candidate.widthMm;
          reportedHeightMm = candidate.heightMm ?? null;
        } else if (candidate.width && candidate.height) {
          reportedWidthMm = candidate.width;
          reportedHeightMm = candidate.height;
        }
      }

      res.json({
        name: def.name,
        isDefault: !!def.isDefault,
        status: def.status ?? null,
        description: def.description ?? null,
        paper: {
          reportedWidthMm,
          reportedHeightMm,
          guessWidthMm,
          sources: paperInfo.from,
          rawKeys: paperInfo.rawKeys
        },
        raw: {
          name: def.name,
          isDefault: def.isDefault,
          options: def.options || {},
        }
      });
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
    autoUpdater.quitAndInstall();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createHiddenWindow();
  setupServer();
  setupAutoUpdate();
  app.setLoginItemSettings({ openAtLogin: true });
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Mantener residente aunque no haya ventanas
});
