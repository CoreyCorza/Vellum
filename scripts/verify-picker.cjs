/**
 * Colour picker: dragging must move only what you are dragging.
 *
 * The picker holds a position in hue/saturation/value and hands out a hex. The bug this
 * guards against was reading that position back out of the hex: three bytes cannot say
 * which hue you were dragging once the colour is near black or grey, so the numbers came
 * back wrong and fought the drag — mildly in the middle of the square, wildly in the
 * corners, where the hue would collapse to red.
 *
 * Every check here is a straight drag along one axis, asserting the other two hold.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))
  await win.webContents.executeJavaScript(
    "(() => { const k = 'vellum.prefs';" +
      " const p = JSON.parse(localStorage.getItem(k) || '{}');" +
      " p.hiddenPanels = []; localStorage.setItem(k, JSON.stringify(p));" +
      ' location.reload(); return 1 })()'
  )
  await new Promise((r) => setTimeout(r, 2600))

  const R = await win.webContents.executeJavaScript(String.raw`(async () => {
    const sv = document.getElementById('sv');
    const hue = document.getElementById('hue');
    const hexField = document.getElementById('hex');
    const ed = window.editor;
    if (!sv || !hue || !ed) return { failed: true, reason: 'picker not mounted' };
    for (const el of [sv, hue]) {
      el.setPointerCapture = () => {};
      el.releasePointerCapture = () => {};
    }

    // A plain timer, not requestAnimationFrame: this window is never shown, and a
    // hidden window is throttled to about one frame a second, which turns fifty drag
    // steps into a minute of waiting. Nothing here is read from an animation frame.
    const frame = () => new Promise((res) => setTimeout(res, 8));
    const ev = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true,
      cancelable: true, clientX: x, clientY: y
    }));

    const num = (v) => parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    const read = () => {
      const out = {};
      for (const row of document.querySelectorAll('.sl')) {
        const lab = row.querySelector('.sl-lab');
        const val = row.querySelector('.sl-val') || row.querySelector('.sl-edit');
        if (!lab || !val) continue;
        const name = lab.textContent.trim();
        if (name === 'Hue' || name === 'Saturation' || name === 'Value') {
          out[name] = num(val.value !== undefined ? val.value : val.textContent);
        }
      }
      return out;
    };

    const setHue = async (frac) => {
      const r = hue.getBoundingClientRect();
      ev(hue, 'pointerdown', r.left + r.width * frac, r.top + r.height / 2);
      ev(hue, 'pointerup', r.left + r.width * frac, r.top + r.height / 2);
      await frame();
    };

    // Drag the square in a straight line, then report how far each channel moved.
    const dragSquare = async (x0, y0, x1, y1, steps) => {
      const r = sv.getBoundingClientRect();
      const at = (t) => [
        r.left + r.width * (x0 + (x1 - x0) * t),
        r.top + r.height * (y0 + (y1 - y0) * t)
      ];
      ev(sv, 'pointerdown', at(0)[0], at(0)[1]);
      await frame();
      const rows = [];
      for (let i = 0; i <= steps; i++) {
        const p = at(i / steps);
        ev(sv, 'pointermove', p[0], p[1]);
        await frame();
        rows.push(read());
      }
      ev(sv, 'pointerup', at(1)[0], at(1)[1]);
      await frame();
      const spread = (k) => {
        const v = rows.map((row) => row[k]);
        return +(Math.max.apply(null, v) - Math.min.apply(null, v)).toFixed(2);
      };
      const backwards = (k, dir) => {
        let n = 0;
        for (let i = 1; i < rows.length; i++) {
          if ((rows[i][k] - rows[i - 1][k]) * dir < -0.5) n++;
        }
        return n;
      };
      return { rows: rows, spread: spread, backwards: backwards };
    };

    const R = {};

    // 1. The bottom edge. Every colour there is black, so hue and value have to be
    //    remembered rather than recovered; saturation is the only thing being dragged.
    await setHue(0.55);
    let d = await dragSquare(0.15, 0.985, 0.85, 0.985, 12);
    R.bottomHueSpread = d.spread('Hue');
    R.bottomValueSpread = d.spread('Value');
    R.bottomSatBackwards = d.backwards('Saturation', 1);
    R.bottomSatRange = [d.rows[0].Saturation, d.rows[d.rows.length - 1].Saturation];

    // 2. The left edge. Every colour there is grey, so the hue has nothing to come from.
    await setHue(0.55);
    d = await dragSquare(0.008, 0.15, 0.008, 0.85, 12);
    R.leftHueSpread = d.spread('Hue');
    R.leftValueBackwards = d.backwards('Value', -1);

    // 3. The middle, where nothing is degenerate. This always worked and must stay so.
    await setHue(0.55);
    d = await dragSquare(0.2, 0.4, 0.8, 0.4, 12);
    R.midValueSpread = d.spread('Value');
    R.midHueSpread = d.spread('Hue');
    R.midSatBackwards = d.backwards('Saturation', 1);

    // 4. Into the very bottom of the square and back out. The colour you went in with
    //    is the colour that comes back.
    await setHue(0.42);
    const r = sv.getBoundingClientRect();
    const col = r.left + r.width * 0.7;
    ev(sv, 'pointerdown', col, r.top + r.height * 0.3);
    await frame();
    const before = read();
    ev(sv, 'pointermove', col, r.top + r.height * 0.999);
    await frame();
    ev(sv, 'pointermove', col, r.top + r.height * 0.3);
    await frame();
    ev(sv, 'pointerup', col, r.top + r.height * 0.3);
    await frame();
    const after = read();
    R.roundTripHueDrift = +Math.abs(after.Hue - before.Hue).toFixed(2);
    R.roundTripSatDrift = +Math.abs(after.Saturation - before.Saturation).toFixed(2);

    // 5. The hue strip moves the hue and nothing else.
    const stripBefore = read();
    await setHue(0.2);
    const stripAfter = read();
    R.hueStripMovedHue = Math.abs(stripAfter.Hue - stripBefore.Hue) > 20;
    R.hueStripSatDrift = +Math.abs(stripAfter.Saturation - stripBefore.Saturation).toFixed(2);
    R.hueStripValDrift = +Math.abs(stripAfter.Value - stripBefore.Value).toFixed(2);

    // 6. A colour arriving from anywhere else is still adopted: an eyedropper, a preset,
    //    a swatch. Ignoring our own output is the fix; ignoring everything is the way
    //    that fix could have broken the picker.
    ed.setBrush({ color: '#ff8800' });
    await frame();
    await frame();
    const adopted = read();
    R.adoptedExternal =
      Math.round(adopted.Hue) >= 30 && Math.round(adopted.Hue) <= 34 &&
      adopted.Saturation > 95 && adopted.Value > 95;
    R.adoptedReads = adopted;

    // 7. The hex field. Typing a colour and leaving the field applies it, and so does
    //    pressing Enter; Escape abandons what was typed. Enter and Escape both hand
    //    focus back, because the field swallows key presses while it holds focus.
    if (!hexField) {
      R.hexField = 'missing';
    } else {
      const setValue = (v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
          .set.call(hexField, v);
        hexField.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const press = (key) => hexField.dispatchEvent(new KeyboardEvent('keydown', {
        key: key, bubbles: true, cancelable: true
      }));

      // Leaving the field.
      hexField.focus();
      setValue('#0033cc');
      await frame();
      hexField.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await frame();
      await frame();
      R.blurApplied = ed.brush.color.toLowerCase() === '#0033cc';

      // Enter.
      hexField.focus();
      setValue('#22bb66');
      await frame();
      press('Enter');
      await frame();
      await frame();
      R.enterApplied = ed.brush.color.toLowerCase() === '#22bb66';
      R.enterDroppedFocus = document.activeElement !== hexField;

      // Escape, which must leave the colour alone and put the field back.
      hexField.focus();
      setValue('#ff0000');
      await frame();
      press('Escape');
      await frame();
      await frame();
      R.escapeKeptColour = ed.brush.color.toLowerCase() === '#22bb66';
      R.escapeResetField = hexField.value.toLowerCase() === '#22bb66';
      R.escapeDroppedFocus = document.activeElement !== hexField;

      // Something that is not a colour: the field goes back to what it was.
      hexField.focus();
      setValue('#zzz');
      await frame();
      press('Enter');
      await frame();
      await frame();
      R.rubbishKeptColour = ed.brush.color.toLowerCase() === '#22bb66';
      R.rubbishResetField = hexField.value.toLowerCase() === '#22bb66';

      // Typing must not reach the painting shortcuts.
      const toolBefore = ed.tool;
      hexField.focus();
      press('e');
      await frame();
      R.typingDidNotSwitchTool = ed.tool === toolBefore;
      hexField.blur();
      await frame();
    }

    return R;
  })()`)

  if (R.failed) {
    console.error('picker: ' + R.reason)
    app.exit(1)
    return
  }

  const fail = []
  const ok = (name, cond, detail) => {
    if (!cond) fail.push(name + ' — ' + detail)
  }

  ok('hue holds along the bottom edge', R.bottomHueSpread <= 1, 'moved ' + R.bottomHueSpread + ' deg')
  ok('value holds along the bottom edge', R.bottomValueSpread <= 1, 'moved ' + R.bottomValueSpread + '%')
  ok('saturation never reverses along the bottom', R.bottomSatBackwards === 0,
    R.bottomSatBackwards + ' backwards steps')
  ok('saturation sweeps the bottom', R.bottomSatRange[1] - R.bottomSatRange[0] > 50,
    'range ' + R.bottomSatRange.join(' to '))
  ok('hue holds down the left edge', R.leftHueSpread <= 1, 'moved ' + R.leftHueSpread + ' deg')
  ok('value never reverses down the left edge', R.leftValueBackwards === 0,
    R.leftValueBackwards + ' backwards steps')
  ok('value holds across the middle', R.midValueSpread <= 1, 'moved ' + R.midValueSpread + '%')
  ok('hue holds across the middle', R.midHueSpread <= 1, 'moved ' + R.midHueSpread + ' deg')
  ok('saturation never reverses across the middle', R.midSatBackwards === 0,
    R.midSatBackwards + ' backwards steps')
  ok('hue survives a trip into black', R.roundTripHueDrift <= 1, 'drifted ' + R.roundTripHueDrift + ' deg')
  ok('saturation survives a trip into black', R.roundTripSatDrift <= 1,
    'drifted ' + R.roundTripSatDrift + '%')
  ok('hue strip moves the hue', R.hueStripMovedHue === true, 'hue did not move')
  ok('hue strip leaves saturation alone', R.hueStripSatDrift <= 1, 'drifted ' + R.hueStripSatDrift + '%')
  ok('hue strip leaves value alone', R.hueStripValDrift <= 1, 'drifted ' + R.hueStripValDrift + '%')
  ok('a colour set from elsewhere is adopted', R.adoptedExternal === true,
    'read back ' + JSON.stringify(R.adoptedReads))
  ok('the hex field exists', R.hexField !== 'missing', 'no hex field')
  ok('a typed hex applies when focus leaves', R.blurApplied === true, 'colour unchanged')
  ok('Enter applies a typed hex', R.enterApplied === true, 'colour unchanged')
  ok('Enter hands focus back', R.enterDroppedFocus === true, 'field kept focus')
  ok('Escape leaves the colour alone', R.escapeKeptColour === true, 'colour changed')
  ok('Escape puts the field back', R.escapeResetField === true, 'field kept the typed text')
  ok('Escape hands focus back', R.escapeDroppedFocus === true, 'field kept focus')
  ok('rubbish leaves the colour alone', R.rubbishKeptColour === true, 'colour changed')
  ok('rubbish is cleared from the field', R.rubbishResetField === true, 'rubbish stayed')
  ok('typing does not reach painting shortcuts', R.typingDidNotSwitchTool === true,
    'pressing e switched tool')

  if (errors.length) fail.push('console errors — ' + errors.slice(0, 3).join(' | '))

  if (fail.length) {
    console.error('picker FAILED:\n  ' + fail.join('\n  '))
    app.exit(1)
  } else {
    console.log('picker: 25/25 — drags move only what you are dragging, and the hex field commits')
    app.exit(0)
  }
})
