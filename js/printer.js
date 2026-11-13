// Prints straight to the Bluetooth thermal printer from the browser, no other app.
// The receipt image (js/receipt.js) is sent as ESC/POS raster commands, the language of
// 58 mm thermal printers (including the built-in printer of Sunmi-type POS terminals).
//
// Two ways to reach the printer, both Chrome-only (Android):
//  - 'ble':    Bluetooth Low Energy (Web Bluetooth). The printer doesn't need to be paired. Default.
//  - 'serial': Bluetooth "classic" (Web Serial). The printer must be paired in the phone's Bluetooth settings.
// The printer that printed last is remembered on the device and used by default from then on:
// later receipts go to it without the printer list (or, where Chrome can't reconnect silently,
// with a list that shows only that printer).
//
// The BLE connection is dropped a few seconds after each print and when the app goes to the background:
// a BLE printer stays invisible to every other phone, app and tab while something is connected to it.
window.Printer = (() => {
  'use strict';

  // GATT services used by common BLE receipt printers, in order of preference.
  const BLE_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000ae30-0000-1000-8000-00805f9b34fb',
  ];
  const SPP = '00001101-0000-1000-8000-00805f9b34fb'; // Bluetooth classic serial port

  const hasBle = () => !!navigator.bluetooth;
  const hasSerial = () => 'serial' in navigator;
  const supported = () => hasBle() || hasSerial();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (name, msg) => { const e = new Error(msg || name); e.name = name; return e; };
  const withTimeout = (p, ms, name) => Promise.race([p, sleep(ms).then(() => { throw fail(name); })]);
  // The browser shows a printer list only within a few seconds of a tap.
  const canAsk = () => navigator.userActivation?.isActive ?? true;

  // ── Remembered printer: { via: 'ble' | 'serial', id, name }
  const SAVED_KEY = 'sf:printer';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVED_KEY)); } catch (_) { /* storage unavailable */ }
  function remember(p) { saved = p; try { localStorage.setItem(SAVED_KEY, JSON.stringify(p)); } catch (_) { /* ignore */ } }
  function forget() { saved = null; try { localStorage.removeItem(SAVED_KEY); } catch (_) { /* ignore */ } }

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

  // ── Bluetooth Low Energy
  let ble = null; // { device, char, chunk, tested } — the device object is kept while the app is open
  let idleTimer = null;
  const disconnectBle = () => { clearTimeout(idleTimer); if (ble?.device.gatt.connected) ble.device.gatt.disconnect(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) disconnectBle(); });
  window.addEventListener('pagehide', disconnectBle);

  // The device to print to, without a list when possible.
  async function bleDevice(choose) {
    if (!choose && ble) return ble.device; // same visit: just reconnect
    if (!choose && saved?.via === 'ble') {
      // Chrome versions that remember permitted devices can reconnect with no list at all.
      const known = (await navigator.bluetooth.getDevices?.().catch(() => [])) || [];
      const device = known.find((d) => d.id === saved.id) || known.find((d) => saved.name && d.name === saved.name);
      if (device) return device;
      if (!canAsk()) throw fail('NeedsTap');
      if (saved.name) { // a list with only the remembered printer
        return navigator.bluetooth.requestDevice({ filters: [{ name: saved.name }], optionalServices: BLE_SERVICES });
      }
    }
    if (!canAsk()) throw fail('NeedsTap');
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  }

  async function findWritable(server) {
    const services = await server.getPrimaryServices().catch(() => []);
    services.sort((a, b) => {
      const rank = (s) => { const i = BLE_SERVICES.indexOf(s.uuid); return i < 0 ? 99 : i; };
      return rank(a) - rank(b);
    });
    for (const svc of services) {
      for (const c of await svc.getCharacteristics().catch(() => [])) {
        if (c.properties.writeWithoutResponse || c.properties.write) return c;
      }
    }
    return null;
  }

  async function viaBle(data, choose) {
    clearTimeout(idleTimer);
    const device = await bleDevice(choose);
    if (ble?.device !== device) {
      disconnectBle();
      ble = { device, char: null, chunk: 180, tested: false };
    }
    if (!device.gatt.connected || !ble.char) {
      const server = await withTimeout(device.gatt.connect(), 10000, 'PrinterOff');
      ble.char = await findWritable(server);
      if (!ble.char) { disconnectBle(); throw fail('NoPrinterService'); }
      await sleep(400); // right after connecting the printer may still drop what it receives
    }
    remember({ via: 'ble', id: device.id, name: device.name || '' });
    const c = ble.char;
    const write = (chunk) => (c.properties.writeWithoutResponse ? c.writeValueWithoutResponse(chunk) : c.writeValueWithResponse(chunk));
    try {
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
    } catch (err) {
      ble.char = null; // reconnect from scratch next time
      throw err;
    } finally {
      // Let the last bytes reach the printer, then let go of it so it's visible to others again.
      idleTimer = setTimeout(disconnectBle, 3000);
    }
  }

  // ── Bluetooth classic (paired printer) via Web Serial. Chrome remembers the permission for good.
  async function viaSerial(data, choose) {
    let port = choose ? null : (await navigator.serial.getPorts())[0] || null;
    if (!port) {
      if (!canAsk()) throw fail('NeedsTap');
      port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP] }); // lists the paired devices
      // Keep only the printer just picked, so it's the one used from now on.
      for (const old of await navigator.serial.getPorts()) if (old !== port) await old.forget?.().catch(() => {});
    }
    if (!port.writable) await withTimeout(port.open({ baudRate: 9600 }), 12000, 'PrinterOff'); // baud rate is ignored over Bluetooth
    remember({ via: 'serial' });
    const writer = port.writable.getWriter();
    try {
      await writer.write(RESET);
      await sleep(200);
      for (let i = 0; i < data.length; i += 1024) await writer.write(data.subarray(i, i + 1024));
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    await sleep(800); // let the last bytes leave before hanging up
    await port.close().catch(() => {});
  }

  // Prints the canvas. Must start from a tap (the browser only shows the printer list after one).
  //  choose = true:  pick the printer again (the old one is forgotten once the new one prints).
  //  via:            'ble' or 'serial'; default = the remembered printer's, or BLE.
  async function print(canvas, { choose = false, via } = {}) {
    if (!supported()) throw fail('NotSupported');
    const v = via || saved?.via || (hasBle() ? 'ble' : 'serial');
    if (v === 'serial' && !hasSerial()) throw fail('NoSerial');
    if (v === 'ble' && !hasBle()) throw fail('NotSupported');
    const data = escpos(canvas);
    const pick = choose || (via && via !== saved?.via);
    if (v === 'serial') await viaSerial(data, pick);
    else await viaBle(data, pick);
  }

  return {
    print, supported, hasBle, hasSerial, escpos, forget,
    saved: () => saved && { ...saved },
  };
})();
