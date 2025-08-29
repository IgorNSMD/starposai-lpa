// main.js
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const cors = require('cors');
const { execFile, exec } = require('child_process');

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'STARPOSAI'); // Windows
fs.mkdirSync(APP_DIR, { recursive: true });
const LOG_FILE = path.join(APP_DIR, 'lpa.log');

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

function now() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z','');
}
function safeJson(x) {
  try { return JSON.stringify(x); } catch { return String(x); }
}
function logd(tag, data) {
  const line = `[${now()}] ${tag} ${typeof data === 'string' ? data : safeJson(data)}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(line.trim());
}

// ====== HELPERS: obtener impresora por defecto / listar ======
async function pickTargetPrinter(win, explicitName) {
  const printers = await win.webContents.getPrintersAsync();
  logd('PRINTERS', printers.map(p => ({ name: p.name, isDefault: p.isDefault, status: p.status })));
  if (!Array.isArray(printers) || printers.length === 0) throw new Error('no_printers');

  if (explicitName) {
    const hit = printers.find(p => p.name.toLowerCase() === String(explicitName).toLowerCase());
    if (!hit) throw new Error(`printer_not_found:${explicitName}`);
    return { name: hit.name, printers };
  }
  const d = printers.find(p => p.isDefault) || printers[0];
  return { name: d.name, printers };
}

// ====== ESTRATEGIAS DE TRANSPORTE ======
// Estrategia A: comando 'print /D:"cola" "archivo.bin"'
function sendViaPrintCmd(targetName, bytes) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `lpa-raw-${Date.now()}.bin`);
    fs.writeFileSync(tmp, bytes);
    const cmd = `print /D:"${targetName}" "${tmp}"`;
    logd('EXEC', cmd);
    exec(cmd, (err, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      resolve({ ok: !err, stdout, stderr, error: err ? String(err) : undefined, strategy: 'printcmd' });
    });
  });
}

// Estrategia B: PowerShell + WinSpool (más bajo nivel)
function sendViaPowerShell(targetName, bytes) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(bytes).toString('base64');
    // Script PowerShell en here-string SIN espacios al final (importante)
    const ps = `
Add-Type -Namespace Native -Name WinSpool -MemberDefinition @"
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
  public static extern bool OpenPrinter(string pPrinterName, out System.IntPtr phPrinter, System.IntPtr pDefault);
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(System.IntPtr hPrinter);
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
  public static extern bool StartDocPrinter(System.IntPtr hPrinter, int Level, System.IntPtr pDocInfo);
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(System.IntPtr hPrinter);
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(System.IntPtr hPrinter);
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(System.IntPtr hPrinter);
  [System.Runtime.InteropServices.DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(System.IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
"@

$printer = "${targetName}"
$bytes = [System.Convert]::FromBase64String("${b64}")

$h = [IntPtr]::Zero
if (-not [Native.WinSpool]::OpenPrinter($printer, [ref]$h, [IntPtr]::Zero)) { throw "OpenPrinter failed" }
try {
  if (-not [Native.WinSpool]::StartDocPrinter($h, 1, [IntPtr]::Zero)) { throw "StartDocPrinter failed" }
  try {
    if (-not [Native.WinSpool]::StartPagePrinter($h)) { throw "StartPagePrinter failed" }
    try {
      $written = 0
      if (-not [Native.WinSpool]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)) { throw "WritePrinter failed" }
      if ($written -lt $bytes.Length) { throw "Short write ($written of $($bytes.Length))" }
    } finally {
      [void][Native.WinSpool]::EndPagePrinter($h)
    }
  } finally {
    [void][Native.WinSpool]::EndDocPrinter($h)
  }
} finally {
  [void][Native.WinSpool]::ClosePrinter($h)
}
`.trim(); // 👈 CLAVE: sin espacios finales

    const psFile = path.join(os.tmpdir(), `lpa-cash-${Date.now()}.ps1`);
    fs.writeFileSync(psFile, ps, { encoding: 'utf8' });

    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`;
    logd('EXEC', cmd);
    exec(cmd, (err, stdout, stderr) => {
      try { fs.unlinkSync(psFile); } catch {}
      resolve({ ok: !err, stdout, stderr, error: err ? String(err) : undefined, strategy: 'powershell' });
    });
  });
}

// Estrategia C (opcional): share UNC \\host\cola (requiere impresora compartida)
// Se omite aquí por simplicidad; la mantienes si ya la tienes como /cash/test2.

// ====== UNIFICADOR ======
async function sendRawBytes(win, bytes, opts = {}) {
  const { printerName = null, simulate = false, strategy = 'powershell' } = opts;

  const { name: target, printers } = await pickTargetPrinter(win, printerName);
  logd('TARGET', { target, requested: printerName, strategy, simulate });

  if (simulate) {
    logd('SIMULATE', { target, bytes: Array.from(bytes) });
    return { ok: true, simulated: true, target, strategy, note: 'No se envió a la impresora.' };
  }

  let result;
  if (strategy === 'printcmd') {
    result = await sendViaPrintCmd(target, bytes);
  } else {
    result = await sendViaPowerShell(target, bytes);
  }

  logd('RESULT', { target, ...result, bytesLen: bytes.length });
  return { ok: !!result.ok, target, ...result };
}

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


  
  // ====== ENDPOINTS ======
  // /print/raw → usa el unificador
  srv.post('/print/raw', async (req, res) => {
    try {
      const { printerName = null, raw, copies = 1, simulate = false, strategy = 'powershell' } = req.body || {};
      if (!Array.isArray(raw)) return res.status(400).json({ ok: false, error: 'raw_required_array' });

      const win = ensureWindow();
      const bytes = Buffer.from(Uint8Array.from(raw));
      logd('PRINT_RAW_REQ', { printerName, copies, simulate, strategy, bytes: Array.from(bytes) });

      // Nota: si necesitas repetir por "copies", haz un bucle; para abrir gaveta, 1 basta.
      const r = await sendRawBytes(win, bytes, { printerName, simulate, strategy });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.error || 'send_failed', detail: r });

      res.json({ ok: true, printer: r.target, strategy: r.strategy, simulated: !!r.simulated, bytes: bytes.length, copies });
    } catch (e) {
      logd('PRINT_RAW_ERR', String(e));
      res.status(500).json({ ok: false, error: String(e) });
    }
  });




  // Abre cajón con ESC/POS (ESC p m t1 t2) usando WritePrinter (robusto)
  // Soporta: { printerName?: string, pin?: 0|1, on?: number, off?: number, copies?: number, simulate?: boolean }
  // ==============================
// POST /cash/open
// body: { printerName?: string, pin?: 0|1, on?: number, off?: number, simulate?: boolean }
// Intenta powershell → si falla, hace fallback a printcmd
// ==============================
  srv.post('/cash/open', async (req, res) => {
    try {
      const { printerName = null } = req.body || {};
      const pin = (Number(req.body?.pin ?? 0) & 0xFF) || 0;   // 0 o 1
      const on  = (Number(req.body?.on  ?? 50) & 0xFF) || 50; // ~2ms * on
      const off = (Number(req.body?.off ?? 200) & 0xFF) || 200;
      const simulate = Boolean(req.body?.simulate);

      const win = ensureWindow();
      const { name: target } = await pickTargetPrinter(win, printerName);

      // Bytes ESC p m t1 t2
      const bytes = Buffer.from([0x1B, 0x70, pin, on, off]);

      // Log de la solicitud
      logd('CASH_OPEN_REQ', { target, requested: printerName, pin, on, off, simulate });

      // Simulación corta
      if (simulate) {
        logd('CASH_OPEN_SIMULATE', { target, bytes: Array.from(bytes) });
        return res.json({
          ok: true,
          simulated: true,
          printer: target,
          strategy: 'simulate',
          pin, on, off
        });
      }

      // 1) Intento con PowerShell/Winspool
      const r1 = await sendViaPowerShell(target, bytes);
      logd('CASH_OPEN_PS_RESULT', { target, ...r1 });

      if (r1.ok) {
        return res.json({
          ok: true,
          printer: target,
          strategy: 'powershell',
          pin, on, off
        });
      }

      // 2) Fallback con print /D:
      const r2 = await sendViaPrintCmd(target, bytes);
      logd('CASH_OPEN_PRINTCMD_RESULT', { target, ...r2 });

      if (r2.ok) {
        return res.json({
          ok: true,
          printer: target,
          strategy: 'printcmd',
          pin, on, off
        });
      }

      // Ambos fallaron
      return res.status(500).json({
        ok: false,
        error: 'send_failed',
        printer: target,
        pin, on, off,
        detail: {
          powershell: { ok: r1.ok, error: r1.error, stdout: r1.stdout, stderr: r1.stderr },
          printcmd:   { ok: r2.ok, error: r2.error, stdout: r2.stdout, stderr: r2.stderr },
        }
      });

    } catch (e) {
      logd('CASH_OPEN_ERR', String(e));
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
  // /cash/test → genera ESC p y llama al mismo unificador
  // Params opcionales: ?pin=0|1&on=50&off=200&simulate=1&strategy=powershell|printcmd&printer=Nombre
  srv.get('/cash/test', async (req, res) => {
    try {
      const q = req.query || {};
      const pin = Number(q.pin ?? 0) & 0xFF;
      const on  = Number(q.on  ?? 50) & 0xFF;
      const off = Number(q.off ?? 200) & 0xFF;
      const simulate = String(q.simulate ?? '').trim() === '1' || String(q.simulate ?? '').toLowerCase() === 'true';
      const strategy = q.strategy === 'printcmd' ? 'printcmd' : 'powershell';
      const printerName = q.printer ? String(q.printer) : null;

      const bytes = Buffer.from([0x1B, 0x70, pin, on, off]); // ESC p m t1 t2
      logd('CASH_TEST_REQ', { pin, on, off, simulate, strategy, printerName, bytes: Array.from(bytes) });

      const win = ensureWindow();
      const r = await sendRawBytes(win, bytes, { printerName, simulate, strategy });
      if (!r.ok) return res.status(500).json({ ok: false, error: r.error || 'send_failed', detail: r });

      res.json({ ok: true, printer: r.target, pin, on, off, strategy: r.strategy, simulated: !!r.simulated });
    } catch (e) {
      logd('CASH_TEST_ERR', String(e));
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // (Opcional) endpoint para leer el log (últimos N KB)
  srv.get('/logs/tail', (req, res) => {
    try {
      const sizeKB = Math.max(1, Math.min(1024, Number(req.query.kb || 64)));
      const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
      if (!stat) return res.json({ ok: true, log: '' });
      const start = Math.max(0, stat.size - sizeKB * 1024);
      const fd = fs.openSync(LOG_FILE, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      res.type('text/plain').send(buf.toString('utf8'));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
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