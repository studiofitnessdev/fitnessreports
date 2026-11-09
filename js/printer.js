// Prints straight to the Bluetooth thermal printer from the browser, no other app.
// The receipt image (js/receipt.js) is sent as ESC/POS raster commands, the language of
// 58 mm thermal printers (including the built-in printer of Sunmi-type POS terminals).
//
// Two ways to reach the printer, both Chrome-only:
//  - 'serial': Bluetooth "classic" (SPP) via Web Serial. Chrome on Android 137+, desktop Chrome 117+.
//              The printer must already be paired in the device's Bluetooth settings.
//  - 'ble':    Bluetooth Low Energy via Web Bluetooth, for printers that only speak BLE.
// The chosen printer is remembered per device: after the first time it prints with one tap.
window.Printer = (() => {
  'use strict';

  const MODE_KEY = 'sf:printerMode';
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

  const hasSerial = () => 'serial' in navigator;
  const hasBle = () => !!navigator.bluetooth;
  const supported = () => hasSerial() || hasBle();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let mode = null;
  try { mode = localStorage.getItem(MODE_KEY); } catch (_) { /* storage unavailable */ }
  const setMode = (m) => { mode = m; try { localStorage.setItem(MODE_KEY, m); } catch (_) { /* ignore */ } };
  const defaultMode = () => (mode === 'ble' && hasBle()) || !hasSerial() ? 'ble' : 'serial';

  // ── ESC/POS: black-and-white canvas → bytes
  function escpos(canvas) {
    const w = canvas.width, h = canvas.height, bw = Math.ceil(w / 8);
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const parts = [Uint8Array.of(0x1b, 0x40)]; // ESC @  reset
    const BAND = 128; // rows per image command: small bands fit the printer's buffer
    for (let y0 = 0; y0 < h; y0 += BAND) {
      const rows = Math.min(BAND, h - y0);
      const out = new Uint8Array(8 + bw * rows);
      out.set([0x1d, 0x76, 0x30, 0x00, bw & 255, bw >> 8, rows & 255, rows >> 8]); // GS v 0  raster image
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

  // ── Bluetooth classic (SPP) via Web Serial
  async function viaSerial(data, choose) {
    let port = choose ? null : (await navigator.serial.getPorts())[0];
    if (choose) for (const old of await navigator.serial.getPorts()) await old.forget?.().catch(() => {});
    if (!port) port = await navigator.serial.requestPort(); // lists the paired Bluetooth devices
    if (!port.writable) await port.open({ baudRate: 9600 }); // baud rate is ignored over Bluetooth
    const writer = port.writable.getWriter();
    try {
      for (let i = 0; i < data.length; i += 1024) await writer.write(data.subarray(i, i + 1024));
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    await sleep(800); // let the last bytes leave before hanging up
    await port.close().catch(() => {});
  }

  // ── Bluetooth Low Energy via Web Bluetooth (kept connected while the app is open)
  let ble = null; // { device, char, chunk }
  async function viaBle(data, choose) {
    if (choose || !ble) {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      ble?.device.gatt.connected && ble.device.gatt.disconnect();
      ble = { device, char: null, chunk: 180 };
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
    }
    const c = ble.char;
    const write = (chunk) => (c.properties.writeWithoutResponse ? c.writeValueWithoutResponse(chunk) : c.writeValueWithResponse(chunk));
    // Big chunks are fast but not every printer accepts them: if the first one fails, go byte-safe (20).
    let i = 0;
    try { await write(data.subarray(0, ble.chunk)); i = ble.chunk; } catch (err) {
      if (ble.chunk === 20) throw err;
      ble.chunk = 20;
    }
    for (let n = 0; i < data.length; i += ble.chunk, n++) {
      await write(data.subarray(i, i + ble.chunk));
      if (c.properties.writeWithoutResponse && n % 20 === 19) await sleep(20); // don't overrun the printer's buffer
    }
  }

  // Prints the canvas. Must start from a tap (the browser only shows the printer list after one).
  // choose = true asks for the printer again; useMode forces 'serial' or 'ble'.
  async function print(canvas, { choose = false, useMode } = {}) {
    if (!supported()) { const e = new Error('Not supported'); e.name = 'NotSupported'; throw e; }
    const m = useMode || defaultMode();
    const data = escpos(canvas);
    if (m === 'ble') await viaBle(data, choose || mode !== 'ble');
    else await viaSerial(data, choose || mode !== 'serial');
    setMode(m);
  }

  // Chrome version (for the "update Chrome" message), or null on other browsers.
  const chromeVersion = () => +(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || 0) || null;

  return { print, supported, hasSerial, hasBle, mode: () => mode, chromeVersion, escpos };
})();
