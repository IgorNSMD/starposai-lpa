// main.js
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');

// ------------------------------
// CONFIGURACIÓN BÁSICA
// ------------------------------
const PORT = 9723;

// Permitir tu frontend en dev y (si quieres) dominios productivos.
// Agrega aquí tus orígenes reales cuando pases a producción.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // 'https://tu-dominio.netlify.app',
]);

// Si quieres proteger con un token, define STARPOSAI_LPA_TOKEN en la máquina
// (Panel de Control → Variables de entorno) y el cliente debe enviar X-LPA-Token.
const API_TOKEN = process.env.STARPOSAI_LPA_TOKEN || null;

// ------------------------------
// INFRA ELECTRON
// ------------------------------
let hiddenWin = null;

function createHiddenWindow() {
  hiddenWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false },
  });
  hiddenWin.on('closed', () => (hiddenWin = null));
}

// Asegura una ventana para poder invocar webContents.getPrintersAsync()
function ensureWindow() {
  let w = hiddenWin || BrowserWindow.getAllWindows()[0];
  if (!w) {
    w = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  }
  return w;
}

// Predeterminada de Windows (por usuario actual) via PowerShell (fallback)
function getWindowsDefaultPrinterName() {
  return new Promise((resolve) => {
    const psArgs = [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_Printer | Where-Object {$_.Default -eq $true} | Select-Object -First 1 -ExpandProperty Name)',
    ];
    execFile('powershell.exe', psArgs, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const name = String(stdout || '').trim();
      resolve(name || null);
    });
  });
}

// Estimar ancho térmico por nombre/opciones
function extractPaperInfoFromOptions(opts = {}) {
  const out = { from: [], rawKeys: Object.keys(opts || {}) };

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

  const maybeStrings = []
    .concat(opts.pageSize || [])
    .concat(opts.media || [])
    .concat(opts.customPaperSize || [])
    .concat(opts.paper || []);

  for (const entry of maybeStrings) {
    if (!entry) continue;
    const s = String(entry);
    const mm = s.match(/(\d+(?:\.\d+)?)\s*mm/i);
    if (mm) out.from.push({ name: s, widthMm: Number(mm[1]) });
    else out.from.push({ name: s });
  }

  return out;
}

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
  return 80; // default razonable
}

// Impresión HTML silenciosa
async function printHTMLSilent(html, deviceName, copies = 1, widthMm = 80) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  const pageCss = `
    <style>
      @media print { @page { size: ${widthMm}mm auto; margin: 0 } body { width: ${widthMm}mm; margin:0 } }
      body { font-family: monospace; font-size: 12px; }
    </style>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8">${pageCss}</head><body>${html}</body></html>`
  ));

  for (let i = 0; i < Math.max(1, Number(copies) || 1); i += 1) {
    // Nota: en Windows `deviceName` debe ser el name exacto
    await win.webContents.print({ silent: true, deviceName });
  }
  await win.destroy();
}

// ------------------------------
// API HTTP (Express)
// ------------------------------
function setupServer() {
  const srv = express();

  srv.use(express.json({ limit: '2mb' }));
  srv.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // requests locales (fetch desde file/insomnia)
        if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        // Si quieres bloquear estrictamente, usa: return cb(new Error('Origen no permitido'));
        return cb(null, true);
      },
    })
  );

  // Token simple opcional
  srv.use((req, res, next) => {
    if (!API_TOKEN) return next();
    const token = req.header('X-LPA-Token');
    if (token === API_TOKEN) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  });

  // Salud
  srv.get('/health', (_req, res) => res.json({ ok: true, version: app.getVersion() }));

  // Solo nombres
  srv.get('/printers', async (_req, res) => {
    try {
      const w = ensureWindow();
      const list = await w.webContents.getPrintersAsync();
      res.json(list.map((p) => p.name));
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  // Dump completo (depuración)
  srv.get('/printers/detail', async (_req, res) => {
    try {
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();
      res.json(printers);
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  // Predeterminada + info de papel
  srv.get('/default-printer', async (_req, res) => {
    try {
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();

      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ error: 'no_printers' });
      }

      let def = printers.find((p) => p.isDefault);

      if (!def) {
        const winDef = await getWindowsDefaultPrinterName();
        if (winDef) def = printers.find((p) => p.name === winDef) || def;
      }

      def = def || printers[0];

      const paperInfo = extractPaperInfoFromOptions(def.options || {});
      const guessWidthMm = guessThermalWidthMm(def.name, paperInfo);

      let reportedWidthMm = null;
      let reportedHeightMm = null;
      const candidate = paperInfo.from.find(
        (p) => typeof p.widthMm === 'number' || (p.width && p.height)
      );
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
        isDefault: Boolean(def.isDefault), // puede venir false si se resolvió por fallback
        status: def.status ?? null,
        description: def.description ?? '',
        paper: {
          reportedWidthMm,
          reportedHeightMm,
          guessWidthMm,
          sources: paperInfo.from,
          rawKeys: paperInfo.rawKeys,
        },
        raw: {
          name: def.name,
          isDefault: def.isDefault,
          options: def.options || {},
        },
      });
    } catch (e) {
      log.error(e);
      res.status(500).send(String(e));
    }
  });

  // Imprimir HTML
  srv.post('/print', async (req, res) => {
    try {
      const { printerName, html, copies = 1, widthMm } = req.body || {};
      if (!html) return res.status(400).json({ ok: false, error: 'html_required' });
      if (!printerName) return res.status(400).json({ ok: false, error: 'printer_required' });

      const w = ensureWindow();
      // (opcional) podrías validar que la impresora exista:
      // const names = (await w.webContents.getPrintersAsync()).map(p => p.name);
      // if (!names.includes(printerName)) return res.status(404).json({ ok: false, error: 'printer_not_found' });

      await printHTMLSilent(html, printerName, copies, Number(widthMm) || 80);
      res.json({ ok: true });
    } catch (e) {
      log.error(e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Imprimir ticket de PRUEBA (HTML)
  srv.post('/print/test', async (req, res) => {
    try {
      const { printerName, copies = 1, widthMm } = req.body || {};

      // 1) Obtener lista de impresoras y resolver target
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();

      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ ok: false, error: 'no_printers' });
      }

      let target =
        printerName ||
        printers.find((p) => p.isDefault)?.name ||
        (await getWindowsDefaultPrinterName()) ||
        printers[0]?.name;

      if (!target) {
        return res.status(404).json({ ok: false, error: 'no_printer_selected' });
      }

      // 2) Calcular ancho térmico sugerido (58/80) si no viene forzado
      const selected = printers.find((p) => p.name === target) || printers[0];
      const paperInfo = extractPaperInfoFromOptions((selected && selected.options) || {});
      const finalWidth = Number(widthMm) || guessThermalWidthMm(target, paperInfo);

      // 3) HTML demo simple (monospace) con @page para ajustarse a 58/80 mm
      const demoHtml = `
        <div style="font-family:monospace">
          <div style="text-align:center;">
            <h3 style="margin:4px 0">STARPOSAI</h3>
            <div>TEST TICKET (LPA)</div>
            <div>${new Date().toLocaleString()}</div>
            <hr/>
          </div>
          <div>Producto A x1 ............. $1.000</div>
          <div>Producto B x2 ............. $3.000</div>
          <div>--------------------------------</div>
          <div><b>TOTAL</b> ................. <b>$4.000</b></div>
          <div style="text-align:center;margin-top:8px">¡Gracias por su compra!</div>
        </div>
      `;

      // 4) Imprimir en silencio
      await printHTMLSilent(demoHtml, target, Number(copies) || 1, finalWidth);

      return res.json({
        ok: true,
        printer: target,
        widthMm: finalWidth,
        copies: Number(copies) || 1,
      });
    } catch (e) {
      log.error(e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });


  srv.listen(PORT, '127.0.0.1', () => log.info(`LPA listening on http://127.0.0.1:${PORT}`));
}

// ------------------------------
// AUTO-UPDATE
// ------------------------------
function setupAutoUpdate() {
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';

  // Descarga y notifica. Cuando termine de bajar, instala y reinicia.
  autoUpdater.checkForUpdatesAndNotify();
  autoUpdater.on('update-downloaded', () => {
    try {
      autoUpdater.quitAndInstall(); // instala y reinicia
    } catch (e) {
      log.error('quitAndInstall failed:', e);
    }
  });
}

// ------------------------------
// CICLO DE VIDA APP
// ------------------------------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // sin menú
  createHiddenWindow();
  setupServer();
  setupAutoUpdate();

  // Iniciar con Windows (por usuario actual)
  app.setLoginItemSettings({ openAtLogin: true });
});

// Mantener residente aunque se cierren ventanas
app.on('window-all-closed', (e) => e.preventDefault());