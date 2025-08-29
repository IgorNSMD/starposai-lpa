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
// Reemplaza toda la función por esta versión
async function printHTMLSilent(html, deviceName, copies = 1, widthMm = 80) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });

  const pageCss = `
    <style>
      @media print { @page { size: ${widthMm}mm auto; margin: 0 }
        body { width: ${widthMm}mm; margin:0 } }
      body { font-family: monospace; font-size: 12px; }
    </style>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8">${pageCss}</head><body>${html}</body></html>`
  ));

  const doPrintOnce = () =>
    new Promise((resolve, reject) => {
      // IMPORTANTE: usar callback; agregar printBackground mejora consistencia
      win.webContents.print(
        { silent: true, deviceName, printBackground: true },
        (success, failureReason) => {
          if (!success) return reject(new Error(failureReason || 'print_failed'));
          resolve();
        }
      );
    });

  const n = Math.max(1, Number(copies) || 1);
  for (let i = 0; i < n; i += 1) {
    await doPrintOnce();
  }

  win.destroy(); // no es async
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
  // ===== Test print (GET: imprime 1 copia en la predeterminada) =====
  srv.get('/print/test', async (_req, res) => {
    try {
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();

      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ ok: false, error: 'no_printers' });
      }

      // Elegir predeterminada (o fallback a la primera disponible)
      let target = printers.find(p => p.isDefault)?.name || printers[0].name;

      // Calcular ancho sugerido (58/80 mm) usando tus utilidades
      const selected = printers.find(p => p.name === target) || printers[0];
      const paperInfo = extractPaperInfoFromOptions((selected && selected.options) || {});
      const finalWidth = guessThermalWidthMm(target, paperInfo);

      // HTML demo (monospace) – se imprime en silencio
      const demoHtml = `
        <div style="font-family:monospace">
          <div style="text-align:center;">
            <h3 style="margin:4px 0">STARPOSAI</h3>
            <div>TEST TICKET</div>
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

      await printHTMLSilent(demoHtml, target, 1, finalWidth); // usa tu función actual
      return res.json({ ok: true, printer: target, widthMm: finalWidth, copies: 1 });
    } catch (e) {
      log.error(e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // ===== Test print (POST: permite opciones) =====
  srv.post('/print/test', async (req, res) => {
    try {
      const { printerName, copies = 1, widthMm } = req.body || {};

      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();
      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ ok: false, error: 'no_printers' });
      }

      let target = printerName || printers.find(p => p.isDefault)?.name || printers[0].name;

      const selected = printers.find(p => p.name === target) || printers[0];
      const paperInfo = extractPaperInfoFromOptions((selected && selected.options) || {});
      const finalWidth = Number(widthMm) || guessThermalWidthMm(target, paperInfo);

      const demoHtml = `
        <div style="font-family:monospace">
          <div style="text-align:center;">
            <h3 style="margin:4px 0">STARPOSAI</h3>
            <div>TEST TICKET</div>
            <div>${new Date().toLocaleString()}</div>
            <hr/>
          </div>
          <div>Item demo ................. $1.000</div>
          <div><b>TOTAL</b> ................. <b>$1.000</b></div>
        </div>
      `;

      await printHTMLSilent(demoHtml, target, Number(copies) || 1, finalWidth);
      return res.json({ ok: true, printer: target, widthMm: finalWidth, copies: Number(copies) || 1 });
    } catch (e) {
      log.error(e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // POST /cash/print-blank
  // Abre el cajón imprimiendo un ticket mínimo.
  // Requiere que el driver de la impresora tenga activado "cash drawer kick".
  srv.post('/cash/print-blank', async (req, res) => {
    try {
      const { printerName = null, widthMm = 80, copies = 1 } = req.body || {};

      // ticket mínimo (casi vacío)
      const html = `
        <!doctype html><html><head><meta charset="utf-8">
        <style>
          @page { size: ${widthMm}mm auto; margin: 0; }
          html, body { margin:0; padding:0; }
          .line { height: 1mm; } /* una "línea" mínima */
        </style>
        </head>
        <body><div class="line">&nbsp;</div></body></html>
      `;

      // Usa tu helper existente de impresión silenciosa:
      // printHTMLSilent(html, deviceName, copies = 1, widthMm = 80)
      await printHTMLSilent(html, printerName, copies, widthMm);

      res.json({ ok: true, printer: printerName, widthMm, copies });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });


  
  // ==============================
  // Imprimir RAW (bytes ESC/POS) usando WritePrinter (robusto)
  // ==============================
  srv.post('/print/raw', async (req, res) => {
    try {
      const { printerName, raw, copies = 1 } = req.body || {};
      if (!Array.isArray(raw)) {
        return res.status(400).json({ ok: false, error: 'raw_required_array' });
      }

      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();
      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ ok: false, error: 'no_printers' });
      }

      const target =
        printerName ||
        printers.find((p) => p.isDefault)?.name ||
        (await getWindowsDefaultPrinterName()) ||
        printers[0].name;

      // ── PowerShell script que usa Winspool (WritePrinter) ──────────
      // Enviamos los bytes sin alterar nada (RAW).
      const psScript = `
    $ErrorActionPreference = 'Stop'
    $printer = ${JSON.stringify(target)}
    $bytes = [byte[]]@(${raw.join(',')})
    $copies = ${Math.max(1, Number(copies) || 1)}

    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public class RawPrinter {
      [StructLayout(LayoutKind.Sequential)]
      public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
      }
      [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true)]
      public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
      [DllImport("winspool.Drv", SetLastError=true)]
      public static extern bool ClosePrinter(IntPtr hPrinter);
      [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true)]
      public static extern bool StartDocPrinter(IntPtr hPrinter, int level, DOCINFOA di);
      [DllImport("winspool.Drv", SetLastError=true)]
      public static extern bool EndDocPrinter(IntPtr hPrinter);
      [DllImport("winspool.Drv", SetLastError=true)]
      public static extern bool StartPagePrinter(IntPtr hPrinter);
      [DllImport("winspool.Drv", SetLastError=true)]
      public static extern bool EndPagePrinter(IntPtr hPrinter);
      [DllImport("winspool.Drv", SetLastError=true)]
      public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
    }
    "@

    IntPtr $h = [IntPtr]::Zero
    if (-not [RawPrinter]::OpenPrinter($printer, [ref]$h, [IntPtr]::Zero)) { throw "OpenPrinter failed: $printer" }

    try {
      $doc = New-Object RawPrinter+DOCINFOA
      $doc.pDocName = "STARPOSAI RAW"
      $doc.pOutputFile = $null
      $doc.pDataType = "RAW"

      if (-not [RawPrinter]::StartDocPrinter($h, 1, $doc)) { throw "StartDocPrinter failed" }
      try {
        for ($i=0; $i -lt $copies; $i++) {
          if (-not [RawPrinter]::StartPagePrinter($h)) { throw "StartPagePrinter failed" }
          try {
            [int]$written = 0
            if (-not [RawPrinter]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)) {
              throw "WritePrinter failed"
            }
          } finally {
            [RawPrinter]::EndPagePrinter($h) | Out-Null
          }
        }
      } finally {
        [RawPrinter]::EndDocPrinter($h) | Out-Null
      }
    } finally {
      [RawPrinter]::ClosePrinter($h) | Out-Null
    }
    [Console]::Out.WriteLine("{ \\"ok\\": true }")
    `;

      const { execFile } = require('child_process');
      const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];

      execFile('powershell.exe', psArgs, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          log.error('print_raw_ps_error', err, stderr);
          return res.status(500).json({ ok: false, error: String(stderr || err.message || err) });
        }
        // devolvemos también impresora y tamaño del buffer para trazabilidad
        res.json({ ok: true, printer: target, bytes: raw.length, copies: Math.max(1, Number(copies)||1) });
      });

    } catch (e) {
      log.error(e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });



  // Abre cajón con ESC/POS (ESC p m t1 t2) usando WritePrinter (robusto)
  // Soporta: { printerName?: string, pin?: 0|1, on?: number, off?: number, copies?: number, simulate?: boolean }
  srv.post('/cash/open', async (req, res) => {
    try {
      const { printerName, pin = 0, on = 50, off = 200, copies = 1, simulate = false } = req.body || {};

      // simulación local (sin hardware): deja "huella" en Descargas/STARPOSAI
      if (simulate) {
        const fs = require('fs');
        const path = require('path');
        const { app } = require('electron');
        const dir = path.join(app.getPath('downloads'), 'STARPOSAI');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `drawer-sim-${Date.now()}.txt`);
        fs.writeFileSync(file, `SIMULATED CASH DRAWER OPEN\npin=${pin} on=${on} off=${off} copies=${copies}\n`);
        return res.json({ ok: true, simulated: true, file, pin, on, off, copies: Math.max(1, Number(copies)||1) });
      }

      // resolver impresora objetivo
      const w = ensureWindow();
      const printers = await w.webContents.getPrintersAsync();
      if (!Array.isArray(printers) || printers.length === 0) {
        return res.status(404).json({ ok: false, error: 'no_printers' });
      }
      const target =
        printerName ||
        printers.find((p) => p.isDefault)?.name ||
        (await getWindowsDefaultPrinterName()) ||
        printers[0].name;

      // bytes ESC p m t1 t2  (clamps 0..255)
      const m  = Math.max(0, Math.min(1, Number(pin) || 0));
      const t1 = Math.max(0, Math.min(255, Number(on)  || 50));
      const t2 = Math.max(0, Math.min(255, Number(off) || 200));
      const raw = [0x1B, 0x70, m, t1, t2];

      // PowerShell script que usa Winspool (WritePrinter) para enviar RAW tal cual
      const psScript = `
        $ErrorActionPreference = 'Stop'
        $printer = ${JSON.stringify(target)}
        $bytes   = [byte[]]@(${raw.join(',')})
        $copies  = ${Math.max(1, Number(copies) || 1)}

        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class RawPrinter {
          [StructLayout(LayoutKind.Sequential)]
          public class DOCINFOA {
            [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
            [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
            [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
          }
          [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true)]
          public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
          [DllImport("winspool.Drv", SetLastError=true)]
          public static extern bool ClosePrinter(IntPtr hPrinter);
          [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true)]
          public static extern bool StartDocPrinter(IntPtr hPrinter, int level, DOCINFOA di);
          [DllImport("winspool.Drv", SetLastError=true)]
          public static extern bool EndDocPrinter(IntPtr hPrinter);
          [DllImport("winspool.Drv", SetLastError=true)]
          public static extern bool StartPagePrinter(IntPtr hPrinter);
          [DllImport("winspool.Drv", SetLastError=true)]
          public static extern bool EndPagePrinter(IntPtr hPrinter);
          [DllImport("winspool.Drv", SetLastError=true)]
          public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
        }
        "@

        IntPtr $h = [IntPtr]::Zero
        if (-not [RawPrinter]::OpenPrinter($printer, [ref]$h, [IntPtr]::Zero)) { throw "OpenPrinter failed: $printer" }

        try {
          $doc = New-Object RawPrinter+DOCINFOA
          $doc.pDocName = "STARPOSAI CASH OPEN"
          $doc.pOutputFile = $null
          $doc.pDataType = "RAW"

          if (-not [RawPrinter]::StartDocPrinter($h, 1, $doc)) { throw "StartDocPrinter failed" }
          try {
            for ($i=0; $i -lt $copies; $i++) {
              if (-not [RawPrinter]::StartPagePrinter($h)) { throw "StartPagePrinter failed" }
              try {
                [int]$written = 0
                if (-not [RawPrinter]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)) {
                  throw "WritePrinter failed"
                }
              } finally {
                [RawPrinter]::EndPagePrinter($h) | Out-Null
              }
            }
          } finally {
            [RawPrinter]::EndDocPrinter($h) | Out-Null
          }
        } finally {
          [RawPrinter]::ClosePrinter($h) | Out-Null
        }
        [Console]::Out.WriteLine("{ \\"ok\\": true }")
        `;

            const { execFile } = require('child_process');
            const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];

            execFile('powershell.exe', psArgs, { windowsHide: true }, (err, stdout, stderr) => {
              if (err) {
                log.error('[cash/open] WritePrinter error:', err, stderr);
                return res.status(500).json({ ok: false, error: String(stderr || err.message || err) });
              }
              res.json({ ok: true, simulated: false, printer: target, pin: m, on: t1, off: t2, copies: Math.max(1, Number(copies)||1) });
            });

          } catch (e) {
            log.error(e);
            res.status(500).json({ ok: false, error: String(e) });
          }
  });


  // === Helpers locales (si ya los tienes, puedes reusar los tuyos) ===
  async function resolveTargetPrinterName(preferred) {
  const w = ensureWindow();
  const printers = await w.webContents.getPrintersAsync();
  if (!Array.isArray(printers) || printers.length === 0) return null;
  if (preferred && printers.some(p => p.name === preferred)) return preferred;
  const def = printers.find(p => p.isDefault)?.name;
  if (def) return def;
  try {
    const sysDef = await getWindowsDefaultPrinterName?.();
    if (sysDef) return sysDef;
  } catch {}
  return printers[0].name;
}



  // ===============================
  // GET /cash/test
  //   Probar apertura de cajón vía ESC p
  //   Parámetros (query):
  //     printer   → nombre exacto (opcional; si no, usa la predeterminada)
  //     pin       → 0 ó 1 (default 0)
  //     on        → 0..255 (default 50)    ; ~2ms * on
  //     off       → 0..255 (default 200)   ; ~2ms * off
  //     simulate  → 1 para no enviar a la impresora (solo log)
  // Ejemplos:
  //   http://127.0.0.1:9723/cash/test
  //   http://127.0.0.1:9723/cash/test?pin=1&on=60&off=220
  //   http://127.0.0.1:9723/cash/test?printer=EPSON%20TM-T20&simulate=1
  // ===============================
  // GET /cash/test?pin=0&on=50&off=200&printer=...&simulate=1
  // main.js (añade/reemplaza este endpoint)
  srv.get('/cash/test', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const printer = url.searchParams.get('printer') || (await getWindowsDefaultPrinterName());
      const pin = Number(url.searchParams.get('pin') ?? 0) | 0;   // 0 ó 1
      const on  = Number(url.searchParams.get('on')  ?? 50) | 0;  // 2ms * on
      const off = Number(url.searchParams.get('off') ?? 200) | 0; // 2ms * off
      const simulate = url.searchParams.has('simulate');

      if (!printer) return res.json({ ok:false, error:'no_default_printer' });
      if (simulate) return res.json({ ok:true, simulated:true, printer, pin, on, off, note:'No se envió a la impresora.' });

      const os  = require('os');
      const fs  = require('fs');
      const path= require('path');
      const { execFile } = require('child_process');

      // bytes ESC p m t1 t2
      const bytes = [27, 112, pin, on, off]; // 0x1B, 0x70, m, t1, t2

      const tmpDir  = os.tmpdir();
      const ps1Path = path.join(tmpDir, `lpa-cash-${Date.now()}.ps1`);

      // Script PowerShell sin here-strings y sin espacios antes de terminadores
      // NOTA: todo está alineado a la columna 1 para evitar 'WhitespaceBeforeHereStringFooter'
      const ps = [
        "Add-Type @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public class RawPrinter {",
        "  [DllImport(\"winspool.drv\", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)]",
        "  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);",
        "  [DllImport(\"winspool.drv\", SetLastError=true)]",
        "  public static extern bool ClosePrinter(IntPtr hPrinter);",
        "  [DllImport(\"winspool.drv\", SetLastError=true)]",
        "  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, IntPtr pDocInfo);",
        "  [DllImport(\"winspool.drv\", SetLastError=true)]",
        "  public static extern bool EndDocPrinter(IntPtr hPrinter);",
        "  [DllImport(\"winspool.drv\", SetLastError=true)]",
        "  public static extern bool StartPagePrinter(IntPtr hPrinter);",
        "  [DllImport(\"winspool.drv\", SetLastError=true)]",
        "  public static extern bool EndPagePrinter(IntPtr hPrinter);",
        "  [DllImport(\"winspool.drv\", SetLastError=true)]",
        "  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);",
        "}",
        "'@",
        `$name = '${printer.replace(/'/g, "''")}'`,
        `$b = [byte[]](${bytes.join(',')})`,
        "$h=[IntPtr]::Zero; if(-not [RawPrinter]::OpenPrinter($name, [ref]$h, [IntPtr]::Zero)){ throw 'OpenPrinter failed' }",
        "try {",
        "  # DOC_INFO_1 (via Marshal): pDocName, pOutputFile, pDatatype='RAW'",
        "  $size = [Runtime.InteropServices.Marshal]::SizeOf([IntPtr]) * 3",
        "  $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)",
        "  [Runtime.InteropServices.Marshal]::WriteIntPtr($p, 0, [Runtime.InteropServices.Marshal]::StringToHGlobalUni('LPA-Cash'))",
        "  [Runtime.InteropServices.Marshal]::WriteIntPtr($p, [IntPtr]::Size, [IntPtr]::Zero)",
        "  [Runtime.InteropServices.Marshal]::WriteIntPtr($p, [IntPtr]::Size*2, [Runtime.InteropServices.Marshal]::StringToHGlobalUni('RAW'))",
        "  try {",
        "    if(-not [RawPrinter]::StartDocPrinter($h, 1, $p)){ throw 'StartDocPrinter failed' }",
        "    try {",
        "      if(-not [RawPrinter]::StartPagePrinter($h)){ throw 'StartPagePrinter failed' }",
        "      try {",
        "        $out=0; if(-not [RawPrinter]::WritePrinter($h,$b,$b.Length,[ref]$out)){ throw 'WritePrinter failed' }",
        "      } finally { [RawPrinter]::EndPagePrinter($h) | Out-Null }",
        "    } finally { [RawPrinter]::EndDocPrinter($h) | Out-Null }",
        "  } finally {",
        "    # libera strings",
        "    [Runtime.InteropServices.Marshal]::FreeHGlobal([Runtime.InteropServices.Marshal]::ReadIntPtr($p,0))",
        "    [Runtime.InteropServices.Marshal]::FreeHGlobal([Runtime.InteropServices.Marshal]::ReadIntPtr($p,[IntPtr]::Size*2))",
        "    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)",
        "  }",
        "} finally { [RawPrinter]::ClosePrinter($h) | Out-Null }"
      ].join("\r\n");

      fs.writeFileSync(ps1Path, ps, { encoding: 'utf8' });

      execFile('powershell.exe',
        ['-NoProfile','-ExecutionPolicy','Bypass','-File', ps1Path],
        { windowsHide:true },
        (err, stdout, stderr) => {
          try { fs.unlinkSync(ps1Path); } catch {}
          if (err) {
            return res.json({ ok:false, error:String(err), stdout, stderr, printer, pin, on, off });
          }
          res.json({ ok:true, printer, pin, on, off, stdout: stdout?.trim() });
        }
      );
    } catch(e) {
      res.json({ ok:false, error:String(e) });
    }
  });

  // main.js (nuevo endpoint)
  /**
   * GET /cash/test2?printer=<name>&pin=0&on=60&off=220
   * Requiere que la impresora esté COMPARTIDA en Windows.
   */
  srv.get('/cash/test2', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const printer = url.searchParams.get('printer') || (await getWindowsDefaultPrinterName());
      const pin = Number(url.searchParams.get('pin') ?? 0) | 0;
      const on  = Number(url.searchParams.get('on')  ?? 60) | 0;
      const off = Number(url.searchParams.get('off') ?? 220) | 0;

      if (!printer) return res.json({ ok:false, error:'no_default_printer' });

      const { exec } = require('child_process');
      const os  = require('os'); const fs = require('fs'); const path = require('path');

      // 1) ShareName
      exec(`powershell -NoProfile -Command "(Get-Printer -Name '${printer.replace(/'/g, "''")}').ShareName"`,
        (e, stdout) => {
          const share = (stdout||'').toString().trim();
          if (e || !share) {
            return res.json({ ok:false, error:'printer_not_shared', note:'Comparte la impresora en Windows o pasa ?share=<nombre>' });
          }

          // 2) archivo temporal con bytes ESC p
          const tmp = path.join(os.tmpdir(), `lpa-cash-${Date.now()}.bin`);
          fs.writeFileSync(tmp, Buffer.from([27,112,pin,on,off]));

          // 3) copy /b a la cola compartida
          const target = `\\\\127.0.0.1\\${share}`;
          exec(`cmd /c copy /b "${tmp}" "${target}"`, (err, so, se) => {
            try { fs.unlinkSync(tmp); } catch {}
            if (err) return res.json({ ok:false, error:String(err), stdout:so, stderr:se, target, share });
            res.json({ ok:true, target, share, pin, on, off, stdout: so?.toString().trim() });
          });
        }
      );
    } catch (e) {
      res.json({ ok:false, error:String(e) });
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