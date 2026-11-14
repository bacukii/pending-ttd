// Ekstrak nomor resi J&T dari string mentah QR/Barcode/OCR
export function extractJntWaybill(rawText) {
  if (!rawText) return '';
  const cleaned = rawText.toUpperCase().replace(/[^A-Z0-9\s-]/g, ' ');

  // Pola utama resi J&T Indonesia (JY, JP, JX, JD, JO, JT, dll.)
  const jntDirect = cleaned.match(/\b(J[A-Z]\d{9,13})\b/);
  if (jntDirect) return jntDirect[1];

  // Koreksi karakter mirip angka pada hasil OCR setelah prefix 2 huruf
  const ocrTokens = cleaned.split(/\s+/);
  for (const token of ocrTokens) {
    if (/^J[A-Z][A-Z0-9]{9,13}$/.test(token)) {
      const prefix = token.slice(0, 2);
      const fixedDigits = token
        .slice(2)
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .replace(/Z/g, '2');
      if (/^\d{9,13}$/.test(fixedDigits)) {
        return prefix + fixedDigits;
      }
    }
  }

  // Fallback 12-15 digit angka
  const numericOnly = cleaned.match(/\b(\d{12,15})\b/);
  if (numericOnly) return numericOnly[1];

  return '';
}

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Gagal memuat ${src}`));
    document.head.appendChild(script);
  });
}

// Jalankan OCR pada elemen Canvas atau File Gambar
export async function runOcrOnImageSource(imageSource) {
  await loadExternalScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
  if (!window.Tesseract) throw new Error('Tesseract OCR tidak tersedia offline.');

  const worker = await window.Tesseract.createWorker('eng');
  try {
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'
    });
    const { data } = await worker.recognize(imageSource);
    const extracted = extractJntWaybill(data.text);
    return {
      waybill: extracted,
      rawText: (data.text || '').trim()
    };
  } finally {
    await worker.terminate();
  }
}

// Scan Barcode / QR / OCR dari file gambar di Galeri
export async function scanWaybillFromImageFile(file, onStatus) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const maxDim = 1400;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  if ('BarcodeDetector' in window) {
    onStatus?.('Membaca barcode/QR dari foto...');
    try {
      const detector = new window.BarcodeDetector({
        formats: ['code_128', 'qr_code', 'code_39', 'ean_13']
      });
      const barcodes = await detector.detect(canvas);
      for (const b of barcodes) {
        const waybill = extractJntWaybill(b.rawValue);
        if (waybill) return { waybill, method: 'Barcode/QR' };
      }
    } catch (_) {}
  }

  onStatus?.('Barcode tidak terbaca, membaca teks resi (OCR)...');
  const ocrResult = await runOcrOnImageSource(canvas);
  if (ocrResult.waybill) {
    return { waybill: ocrResult.waybill, method: 'OCR Teks' };
  }

  throw new Error('Nomor resi tidak ditemukan pada foto tersebut.');
}

// Ambil koordinat GPS singkat secara non-blocking (maksimal 2.5 detik)
function getQuickLocationText() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve('');
      return;
    }
    const timer = setTimeout(() => resolve(''), 2500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        const lat = pos.coords.latitude.toFixed(5);
        const lon = pos.coords.longitude.toFixed(5);
        resolve(`${lat}, ${lon}`);
      },
      () => {
        clearTimeout(timer);
        resolve('');
      },
      { enableHighAccuracy: false, timeout: 2200, maximumAge: 120000 }
    );
  });
}

export function formatTimestamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const tgl = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const jam = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${tgl} ${jam}`;
}

// Kompresi foto bersih (tanpa watermark) + ambil metadata waktu & GPS untuk UI overlay
export async function processPodImage(fileOrBlob, options = {}) {
  const {
    captureTimestamp = Date.now(),
    includeGps = true
  } = options;

  const [bitmap, gpsText] = await Promise.all([
    createImageBitmap(fileOrBlob),
    includeGps ? getQuickLocationText() : Promise.resolve('')
  ]);

  const maxSide = 1280;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * ratio);
  const height = Math.round(bitmap.height * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82)
  );

  return {
    blob,
    timestamp: captureTimestamp,
    timeFormatted: formatTimestamp(captureTimestamp),
    gpsText
  };
}

