// list-printers.js
async function main() {
  try {
    const res = await fetch('http://127.0.0.1:9723/printers');
    const printers = await res.json();
    console.log('🖨️ Impresoras detectadas:\n', printers);
  } catch (e) {
    console.error('❌ No se pudo obtener la lista. ¿Está corriendo el LPA?');
  }
}
main();