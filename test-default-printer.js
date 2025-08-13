// test-default-printer.js
async function main() {
  try {
    const res = await fetch('http://127.0.0.1:9723/default-printer');
    if (!res.ok) {
      throw new Error(`Error HTTP: ${res.status}`);
    }

    const defaultPrinter = await res.json();
    console.log('🖨️ Impresora por defecto:\n', defaultPrinter);

  } catch (e) {
    console.error('❌ No se pudo obtener la impresora por defecto. ¿Está corriendo el LPA local?', e.message);
  }
}

main();
