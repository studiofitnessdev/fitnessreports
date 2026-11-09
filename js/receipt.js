// Sale receipt as an image for the 58 mm thermal printer (shared to the Mini Impressora app).
// 384 px wide = 48 mm of printable width at 203 dpi, the standard for 58 mm paper.
// Pure black on white, no gray or red: thermal heads print only black, and colors come out faint or dotted.
// Usage: await Receipt.render({ gym, number, when, client, cpf, plan, days, time, start, end, payment, amount, notes, signature })
// Every field is an already formatted string; empty ones are skipped. Returns a PNG Blob.
window.Receipt = (() => {
  'use strict';

  const W = 384;
  const PAD = 6;
  const FONT = 'Barlow, "Helvetica Neue", Arial, sans-serif';
  const fontsReady = () => Promise.all(['400 22px Barlow', '600 22px Barlow', '700 22px Barlow']
    .map((f) => document.fonts?.load(f).catch(() => null)));

  function render(r) {
    return fontsReady().then(() => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = 3000; // cropped at the end
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, c.height);
      ctx.fillStyle = '#000';
      ctx.strokeStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      let y = 4;

      const font = (weight, size) => { ctx.font = `${weight} ${size}px ${FONT}`; };

      // Split text into lines that fit `max` px (long words are cut too).
      function wrap(text, max) {
        const out = [];
        for (const para of String(text).split(/\r?\n/)) {
          let line = '';
          for (const word of para.split(/\s+/).filter(Boolean)) {
            const tryLine = line ? `${line} ${word}` : word;
            if (ctx.measureText(tryLine).width <= max) { line = tryLine; continue; }
            if (line) out.push(line);
            line = word;
            while (ctx.measureText(line).width > max) { // a single word wider than the paper
              let i = line.length - 1;
              while (i > 1 && ctx.measureText(line.slice(0, i)).width > max) i--;
              out.push(line.slice(0, i));
              line = line.slice(i);
            }
          }
          out.push(line);
        }
        return out;
      }

      function text(str, { weight = 400, size = 22, align = 'left', gap = 6 } = {}) {
        font(weight, size);
        ctx.textAlign = align;
        const x = align === 'center' ? W / 2 : align === 'right' ? W - PAD : PAD;
        for (const line of wrap(str, W - 2 * PAD)) {
          y += size;
          ctx.fillText(line, x, y);
          y += gap;
        }
      }

      // "Label ........ Value" on one line, or the value on the next line when it doesn't fit.
      function row(label, value, { size = 22, valueWeight = 700 } = {}) {
        if (!value) return;
        font(400, size);
        const lw = ctx.measureText(label).width;
        font(valueWeight, size);
        const vw = ctx.measureText(value).width;
        if (lw + 14 + vw <= W - 2 * PAD) {
          y += size;
          font(400, size); ctx.textAlign = 'left'; ctx.fillText(label, PAD, y);
          font(valueWeight, size); ctx.textAlign = 'right'; ctx.fillText(value, W - PAD, y);
          y += 7;
        } else {
          text(label, { size, gap: 2 });
          text(value, { weight: valueWeight, size, align: 'right', gap: 7 });
        }
      }

      function rule(dashed = true) {
        y += 9;
        ctx.lineWidth = 2;
        ctx.setLineDash(dashed ? [8, 6] : []);
        ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
        ctx.setLineDash([]);
        y += 9;
      }

      // ── Header
      text('STUDIO FITNESS', { weight: 700, size: 38, align: 'center', gap: 2 });
      text('TREINAMENTO PERSONALIZADO', { weight: 600, size: 17, align: 'center', gap: 8 });
      for (const line of r.gym?.address || []) text(line, { size: 18, align: 'center', gap: 3 });
      if (r.gym?.phone) text(`WhatsApp ${r.gym.phone}`, { size: 18, align: 'center', gap: 3 });
      rule(false);

      text(r.number ? `RECIBO Nº ${r.number}` : 'RECIBO', { weight: 700, size: 30, align: 'center', gap: 4 });
      if (r.when) text(r.when, { size: 21, align: 'center', gap: 2 });
      rule();

      // ── Client
      text('CLIENTE', { weight: 600, size: 17, gap: 2 });
      text(r.client || '', { weight: 700, size: 25, gap: 4 });
      if (r.cpf) row('CPF', r.cpf);
      rule();

      // ── Plan
      row('Plano', r.plan);
      row('Dias por semana', r.days);
      row('Horário', r.time);
      row('Início', r.start);
      row('Vencimento', r.end);
      rule();

      // ── Payment
      row('Pagamento', r.payment);
      y += 6;
      font(700, 34);
      const big = ctx.measureText(r.amount || '').width;
      font(700, 24);
      if (ctx.measureText('TOTAL').width + 14 + big <= W - 2 * PAD) {
        y += 34;
        ctx.textAlign = 'left'; ctx.fillText('TOTAL', PAD, y);
        font(700, 34); ctx.textAlign = 'right'; ctx.fillText(r.amount || '', W - PAD, y);
        y += 6;
      } else {
        text('TOTAL', { weight: 700, size: 24, gap: 2 });
        text(r.amount || '', { weight: 700, size: 34, align: 'right' });
      }

      // ── Notes and signature
      if (r.notes || r.signature) rule();
      if (r.notes) {
        text('OBSERVAÇÃO', { weight: 600, size: 17, gap: 2 });
        text(r.notes, { size: 21, gap: 4 });
      }
      if (r.signature) {
        if (r.notes) y += 6;
        row('Atendido por', r.signature);
      }
      rule(false);
      text('Obrigado! Bora treinar!', { weight: 700, size: 24, align: 'center', gap: 4 });
      y += 70; // blank paper before the tear bar, so it never cuts the text

      // Crop and turn every pixel pure black or white (crisp print, no gray dots).
      const out = document.createElement('canvas');
      out.width = W;
      out.height = Math.ceil(y);
      const octx = out.getContext('2d');
      octx.drawImage(c, 0, 0);
      const img = octx.getImageData(0, 0, out.width, out.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 160 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
    });
  }

  return { render };
})();
