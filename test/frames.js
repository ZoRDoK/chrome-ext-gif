// Синтетические кадры для тестов: панель с плоскими цветами и дашборд
// с текстом, графиком, фото-областью и движущимися элементами. Оба сценария
// используются и для проверки энкодера, и для калибровки оценки размера.
const DASHBOARD_SEED = 7;

function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePanelFrame(size, time) {
  const data = new Uint8ClampedArray(size * size * 4);
  const put = (x, y, r, g, b, alpha = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = ((y | 0) * size + (x | 0)) * 4;
    data[offset] = data[offset] * (1 - alpha) + r * alpha;
    data[offset + 1] = data[offset + 1] * (1 - alpha) + g * alpha;
    data[offset + 2] = data[offset + 2] * (1 - alpha) + b * alpha;
    data[offset + 3] = 255;
  };
  const rect = (x0, y0, w, h, color) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) put(x, y, color[0], color[1], color[2]);
    }
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = (x + y) / (2 * size);
      put(x, y, 24 + k * 40, 32 + k * 48, 52 + k * 70);
    }
  }
  rect(0, 0, size, 48, [30, 41, 59]);
  rect(0, 48, 120, size - 48, [241, 245, 249]);
  for (let i = 0; i < 8; i++) {
    rect(140, 70 + i * 30, 180 + ((i * 53) % 160), 12, [51, 65, 85]);
  }
  for (let i = 0; i < 5; i++) {
    const height = Math.round(60 + 120 * Math.abs(Math.sin(time * 2 + i)));
    rect(20 + i * 20, size - 20 - height, 14, height, [37, 99, 235]);
  }
  const accentX = Math.round((0.5 + 0.4 * Math.sin(time * 3)) * (size - 60));
  const accentY = Math.round(size * 0.55 + 40 * Math.cos(time * 4));
  rect(accentX, accentY, 60, 60, [239, 68, 68]);

  return data;
}

export function makeDashboardFrame(size, time) {
  const data = new Uint8ClampedArray(size * size * 4);
  const random = seeded(DASHBOARD_SEED);
  const put = (x, y, r, g, b, alpha = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = ((y | 0) * size + (x | 0)) * 4;
    data[offset] = data[offset] * (1 - alpha) + r * alpha;
    data[offset + 1] = data[offset + 1] * (1 - alpha) + g * alpha;
    data[offset + 2] = data[offset + 2] * (1 - alpha) + b * alpha;
    data[offset + 3] = 255;
  };
  const rect = (x0, y0, w, h, color) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) put(x, y, color[0], color[1], color[2]);
    }
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = 1 - (x + y) / (4 * size);
      put(x, y, 248 * k + 8, 250 * k + 6, 252 * k + 8);
    }
  }
  rect(0, 0, size, 44, [15, 23, 42]);
  for (let i = 0; i < 4; i++) rect(24 + i * 60, 16, 44, 12, [226, 232, 240]);
  rect(size - 90, 12, 70, 20, [56, 189, 248]);

  rect(32, 70, 200, 150, [255, 255, 255]);
  for (let y = 78; y < 190; y++) {
    for (let x = 40; x < 224; x++) {
      const base = 60 + 40 * Math.sin((x + time * 60) / 22) + 30 * Math.cos(y / 17);
      const noise = (random() - 0.5) * 10;
      put(x, y, base + noise, 90 + base * 0.6 + noise, 160 + base * 0.3 + noise);
    }
  }

  rect(280, 70, 200, 150, [255, 255, 255]);
  for (let x = 292; x < 468; x++) {
    const y = Math.round(150 + 45 * Math.sin((x + time * 140) / 20));
    put(x, y, 37, 99, 235);
    put(x, y + 1, 37, 99, 235, 0.5);
    for (let fill = y + 2; fill < 205; fill++) put(x, fill, 37, 99, 235, 0.08);
  }

  for (let i = 0; i < 12; i++) {
    const y = 250 + i * 20;
    const width = 90 + ((i * 83) % 300);
    for (let x = 48; x < 48 + width; x++) {
      const edge = x === 48 || x === 48 + width - 1 ? 0.4 : 1;
      put(x, y, 31, 41, 55, edge);
      put(x, y + 1, 31, 41, 55, edge);
      put(x, y + 2, 31, 41, 55, edge * 0.65);
    }
  }

  const filled = Math.round((Math.sin(time * 1.7) * 0.5 + 0.5) * (size - 120));
  rect(60, size - 30, size - 120, 10, [203, 213, 225]);
  rect(60, size - 30, filled, 10, [34, 197, 94]);
  const accentX = Math.round((0.5 + 0.44 * Math.sin(time * 2.2)) * (size - 48));
  rect(accentX, 230, 30, 30, [250, 204, 21]);

  return data;
}
