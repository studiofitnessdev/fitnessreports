// Prints straight to the Bluetooth thermal printer from the browser, no other app.
// The receipt image (js/receipt.js) is sent as ESC/POS raster commands, the language of
// 58 mm thermal printers (including the built-in printer of Sunmi-type POS terminals).
//
// The printer is reached over Bluetooth Low Energy (Web Bluetooth, Chrome on Android).
// Chrome lists the printer the first time it prints after the app opens; it stays connected after that.
window.Printer = (() => {
  'use strict';

  // GATT services used by common BLE receipt printers; the first writable characteristic is used.
  const BLE_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000ae30-0000-1000-8000-00805f9b34fb',
  ];

  const supported = () => !!navigator.bluetooth;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── ESC/POS: black-and-white canvas → bytes
  // The reset (ESC @) is sent on its own, with a pause after it: printers drop the bytes that arrive
  // while they reset. If a picture header is lost, the printer prints that picture's bytes as text
  // (Chinese characters and symbols), so the picture also starts with a blank band that prints nothing.
  const RESET = Uint8Array.of(0x1b, 0x40); // ESC @
  const BLANK_ROWS = 16;
  function escpos(canvas) {
    const w = canvas.width, h = canvas.height, bw = Math.ceil(w / 8);
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const band = (rows) => {
      const out = new Uint8Array(8 + bw * rows);
      out.set([0x1d, 0x76, 0x30, 0x00, bw & 255, bw >> 8, rows & 255, rows >> 8]); // GS v 0  raster image
      return out;
    };
    const parts = [band(BLANK_ROWS)]; // all white
    const BAND = 64; // rows per image command: small bands fit the printer's buffer
    for (let y0 = 0; y0 < h; y0 += BAND) {
      const rows = Math.min(BAND, h - y0);
      const out = band(rows);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < w; x++) {
          if (px[((y0 + y) * w + x) * 4] < 128) out[8 + y * bw + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      parts.push(out);
    }
    parts.push(Uint8Array.of(0x1b, 0x64, 5)); // ESC d 5  feed 5 lines, so the tear bar clears the text
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  }

  // ── Send over Bluetooth Low Energy (kept connected while the app is open)
  let ble = null; // { device, char, chunk, tested }
  async function send(data, choose) {
    if (choose || !ble) {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      ble?.device.gatt.connected && ble.device.gatt.disconnect();
      ble = { device, char: null, chunk: 180, tested: false };
    }
    if (!ble.device.gatt.connected || !ble.char) {
      const server = await ble.device.gatt.connect();
      ble.char = null;
      for (const svc of await server.getPrimaryServices().catch(() => [])) {
        for (const c of await svc.getCharacteristics().catch(() => [])) {
          if (c.properties.writeWithoutResponse || c.properties.write) { ble.char = c; break; }
        }
        if (ble.char) break;
      }
      if (!ble.char) { const e = new Error('No writable characteristic'); e.name = 'NoPrinterService'; throw e; }
      await sleep(400); // right after connecting the printer may still drop what it receives
    }
    const c = ble.char;
    const write = (chunk) => (c.properties.writeWithoutResponse ? c.writeValueWithoutResponse(chunk) : c.writeValueWithResponse(chunk));
    // Big chunks are fast but not every printer accepts them. Test the size with zero bytes, which the
    // printer ignores, so a failed or half-received test can't damage the receipt; if it fails, go byte-safe (20).
    if (!ble.tested) {
      try { await write(new Uint8Array(ble.chunk)); } catch (_) { ble.chunk = 20; }
      ble.tested = true;
    }
    await write(RESET);
    await sleep(200);
    for (let i = 0, n = 0; i < data.length; i += ble.chunk, n++) {
      await write(data.subarray(i, i + ble.chunk));
      if (c.properties.writeWithoutResponse && n % 20 === 19) await sleep(20); // don't overrun the printer's buffer
    }
  }

  // Prints the canvas. Must start from a tap (the browser only shows the printer list after one).
  // choose = true asks for the printer again.
  async function print(canvas, { choose = false } = {}) {
    if (!supported()) { const e = new Error('Not supported'); e.name = 'NotSupported'; throw e; }
    await send(escpos(canvas), choose);
  }

  return { print, supported, escpos };
})();
