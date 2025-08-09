// test-print.js
// Uso:
//   node test-print.js "<NOMBRE_EXACTO_IMPRESORA>" [copies] [--file ruta/al/archivo.html]
//
// Ejemplos:
//   node test-print.js "Impresora Ticket 80mm (Ficticia)"
//   node test-print.js "Microsoft Print to PDF" 2 --file ticket.html

const fs = require('fs');
const path = require('path');

const PRINTER = process.argv[2];
const COPIES = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1;
const FILE_FLAG_INDEX = process.argv.indexOf('--file');
const HAS_FILE = FILE_FLAG_INDEX !== -1 && process.argv[FILE_FLAG_INDEX + 1];

if (!PRINTER) {
  console.error('❌ Debes indicar el nombre exacto de la impresora como primer argumento.');
  process.exit(1);
}

let html = `<h3>STARPOSAI</h3><hr/>Ticket de prueba<br/>Total: $12.345<br/><small>${new Date().toLocaleString()}</small>`;

if (HAS_FILE) {
  const filePath = path.resolve(process.argv[FILE_FLAG_INDEX + 1]);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ No se encontró el archivo: ${filePath}`);
    process.exit(1);
  }
  html = fs.readFileSync(filePath, 'utf8');
}

async function main() {
  const url = 'http://127.0.0.1:9723/print';
  const body = { printerName: PRINTER, copies: COPIES, html };

  try {
    // Node 18+ trae fetch nativo; si usas Node 16, instala node-fetch.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('❌ Error HTTP:', res.status, data);
      process.exit(1);
    }

    console.log('✅ Petición enviada correctamente.');
    console.log('Respuesta del LPA:', data);
  } catch (err) {
    console.error('❌ No se pudo contactar al LPA:', err.message);
    console.error('Verifica que el LPA esté corriendo en http://127.0.0.1:9723');
    process.exit(1);
  }
}

main();