import {
  initStoragePersistence,
  saveGroup,
  getAllGroups,
  getGroupById,
  deleteGroup,
  saveMeta,
  getMeta,
  cleanupOldDoneGroups
} from './db.js';
import {
  extractJntWaybill,
  runOcrOnImageSource,
  scanWaybillFromImageFile,
  processPodImage,
  formatTimestamp
} from './scanner-media.js';

const blobUrlCache = new WeakMap();
function getBlobUrl(blob) {
  if (!blob) return '';
  if (!blobUrlCache.has(blob)) {
    blobUrlCache.set(blob, URL.createObjectURL(blob));
  }
  return blobUrlCache.get(blob);
}

function getGroupPhotos(group) {
  if (Array.isArray(group.photos)) return group.photos;
  if (group.photoBlob) {
    return [
      {
        id: 'legacy-photo',
        blob: group.photoBlob,
        timestamp: group.createdAt,
        gpsText: ''
      }
    ];
  }
  return [];
}

const state = {
  activeTab: 'INPUT',
  lockMode: false,
  autoCompleteMode: false,
  activeGroupId: null,
  draft: {
    waybills: [],
    recipient: '',
    photos: [] // Array of { id, blob, timestamp, gpsText }
  },
  groups: [],
  scannerStream: null,
  scannerRaf: null,
  torchOn: false,
  lastScanCode: '',
  lastScanTime: 0,
  zoomedPhoto: null, // { blob, filename }
  undoPayload: null,
  undoTimer: null
};

const el = {
  netDot: document.getElementById('netDot'),
  netLabel: document.getElementById('netLabel'),
  headerPendingCount: document.getElementById('headerPendingCount'),
  navPendingBadge: document.getElementById('navPendingBadge'),
  navDoneBadge: document.getElementById('navDoneBadge'),
  viewInput: document.getElementById('viewInput'),
  viewList: document.getElementById('viewList'),
  toggleLockMode: document.getElementById('toggleLockMode'),
  lockBadge: document.getElementById('lockBadge'),
  draftWaybillCount: document.getElementById('draftWaybillCount'),
  draftWaybillList: document.getElementById('draftWaybillList'),
  inputManualWaybill: document.getElementById('inputManualWaybill'),
  btnAddManualWaybill: document.getElementById('btnAddManualWaybill'),
  btnPasteWaybill: document.getElementById('btnPasteWaybill'),
  btnOpenScanner: document.getElementById('btnOpenScanner'),
  inputScanGallery: document.getElementById('inputScanGallery'),
  galleryScanStatus: document.getElementById('galleryScanStatus'),
  inputRecipient: document.getElementById('inputRecipient'),
  inputCameraPhoto: document.getElementById('inputCameraPhoto'),
  inputGalleryPhoto: document.getElementById('inputGalleryPhoto'),
  draftPhotoCount: document.getElementById('draftPhotoCount'),
  draftPhotoPreviewWrap: document.getElementById('draftPhotoPreviewWrap'),
  draftPhotoGrid: document.getElementById('draftPhotoGrid'),
  btnClearDraftPhotos: document.getElementById('btnClearDraftPhotos'),
  btnSaveGroup: document.getElementById('btnSaveGroup'),
  toggleAutoComplete: document.getElementById('toggleAutoComplete'),
  inputSearchResi: document.getElementById('inputSearchResi'),
  groupCardsContainer: document.getElementById('groupCardsContainer'),
  btnExportText: document.getElementById('btnExportText'),
  // Modal Scanner
  scannerModal: document.getElementById('scannerModal'),
  scannerVideo: document.getElementById('scannerVideo'),
  scannerStatusText: document.getElementById('scannerStatusText'),
  modalScannedCount: document.getElementById('modalScannedCount'),
  btnToggleTorch: document.getElementById('btnToggleTorch'),
  btnCloseScanner: document.getElementById('btnCloseScanner'),
  btnCaptureOcr: document.getElementById('btnCaptureOcr'),
  // Zoom & Toast
  photoZoomModal: document.getElementById('photoZoomModal'),
  zoomBackdropArea: document.getElementById('zoomBackdropArea'),
  zoomedImg: document.getElementById('zoomedImg'),
  zoomMetaOverlay: document.getElementById('zoomMetaOverlay'),
  btnDownloadZoomed: document.getElementById('btnDownloadZoomed'),
  toastBar: document.getElementById('toastBar'),
  toastMessage: document.getElementById('toastMessage'),
  btnToastUndo: document.getElementById('btnToastUndo')
};

// --- Utilitas Feedback & Toast ---
function triggerFeedback() {
  if (navigator.vibrate) navigator.vibrate(60);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1040, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch (_) {}
}

function showToast(message, undoCallback = null) {
  clearTimeout(state.undoTimer);
  el.toastMessage.textContent = message;
  if (undoCallback) {
    state.undoPayload = undoCallback;
    el.btnToastUndo.classList.remove('hidden');
  } else {
    state.undoPayload = null;
    el.btnToastUndo.classList.add('hidden');
  }
  el.toastBar.classList.remove('hidden');
  state.undoTimer = setTimeout(() => {
    el.toastBar.classList.add('hidden');
    state.undoPayload = null;
  }, undoCallback ? 5000 : 2800);
}

el.btnToastUndo.addEventListener('click', async () => {
  if (state.undoPayload) {
    await state.undoPayload();
    state.undoPayload = null;
  }
  el.toastBar.classList.add('hidden');
});

// --- Status Jaringan & Service Worker ---
function updateNetworkStatus() {
  const online = navigator.onLine;
  el.netDot.className = `w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-amber-400'}`;
  el.netLabel.textContent = online ? 'Online • Offline Ready' : 'Mode Offline Lokal';
}

window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW gagal terdaftar:', err);
  });
}

// --- Auto-Save Draf Input ---
async function persistDraftState() {
  await saveMeta('input_draft', {
    lockMode: state.lockMode,
    waybills: state.draft.waybills,
    recipient: state.draft.recipient,
    photos: state.draft.photos
  });
}

async function restoreAppState() {
  state.autoCompleteMode = await getMeta('auto_complete_mode', false);
  el.toggleAutoComplete.checked = state.autoCompleteMode;
  state.activeGroupId = await getMeta('last_active_group_id', null);

  const savedDraft = await getMeta('input_draft', null);
  if (savedDraft) {
    state.lockMode = Boolean(savedDraft.lockMode);
    el.toggleLockMode.checked = state.lockMode;
    state.draft.waybills = Array.isArray(savedDraft.waybills) ? savedDraft.waybills : [];
    state.draft.recipient = savedDraft.recipient || '';
    el.inputRecipient.value = state.draft.recipient;
    state.draft.photos = Array.isArray(savedDraft.photos) ? savedDraft.photos : [];
  }
  renderDraftUI();
}

// --- Manajemen Draf Resi & Multi-Foto ---
function addWaybillToDraft(rawInput) {
  const code = extractJntWaybill(rawInput) || rawInput.trim().toUpperCase();
  if (!code || code.length < 6) {
    showToast('Format nomor resi tidak valid.');
    return false;
  }

  if (state.draft.waybills.includes(code)) {
    showToast(`Resi ${code} sudah ada di daftar.`);
    return false;
  }

  const existsInPending = state.groups.some(
    (g) => g.status === 'PENDING' && g.waybills.some((w) => w.code === code)
  );
  if (existsInPending) {
    showToast(`Peringatan: ${code} sudah tercatat di Pending!`);
  }

  if (!state.lockMode && state.draft.waybills.length >= 1) {
    state.draft.waybills = [code];
    showToast(`Resi diperbarui: ${code} (Aktifkan Lock untuk multi-paket)`);
  } else {
    state.draft.waybills.push(code);
    showToast(`Resi ditambahkan: ${code}`);
  }

  triggerFeedback();
  renderDraftUI();
  persistDraftState();
  return true;
}

function renderDraftUI() {
  el.lockBadge.classList.toggle('hidden', !state.lockMode);
  el.inputScanGallery.multiple = state.lockMode;
  el.inputGalleryPhoto.multiple = state.lockMode;

  const wCount = state.draft.waybills.length;
  const pCount = state.draft.photos.length;

  el.draftWaybillCount.textContent = `${wCount} Resi`;
  el.modalScannedCount.textContent = `${wCount} Resi`;
  el.draftPhotoCount.textContent = `${pCount} Foto`;

  if (wCount === 0) {
    el.draftWaybillList.innerHTML =
      '<p class="text-xs text-slate-500 italic">Belum ada resi di-scan.</p>';
  } else {
    el.draftWaybillList.innerHTML = state.draft.waybills
      .map(
        (code, idx) => `
      <div class="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="w-5 h-5 rounded-full bg-red-600/20 text-red-400 text-[11px] font-bold flex items-center justify-center">${idx + 1}</span>
          <span class="font-mono font-bold text-sm tracking-wide text-white">${code}</span>
        </div>
        <button type="button" data-remove-idx="${idx}" class="text-xs text-slate-400 hover:text-red-400 px-2 py-1">
          Hapus
        </button>
      </div>`
      )
      .join('');
  }

  if (pCount > 0) {
    el.draftPhotoPreviewWrap.classList.remove('hidden');
    el.draftPhotoGrid.innerHTML = state.draft.photos
      .map((photo, idx) => {
        const url = getBlobUrl(photo.blob);
        const jam = new Date(photo.timestamp).toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit'
        });
        return `
        <div class="relative aspect-square rounded-xl overflow-hidden border border-slate-700 bg-slate-950">
          <img src="${url}" data-zoom-draft-idx="${idx}" alt="Foto ${idx + 1}" class="w-full h-full object-cover cursor-pointer" />
          <span class="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/75 text-[10px] font-bold text-white">
            #${idx + 1} • ${jam}
          </span>
          <button type="button" data-remove-photo-idx="${idx}"
            class="absolute top-1 right-1 w-6 h-6 rounded-full bg-red-600/90 text-white text-xs font-black flex items-center justify-center shadow">
            ×
          </button>
        </div>`;
      })
      .join('');
  } else {
    el.draftPhotoPreviewWrap.classList.add('hidden');
    el.draftPhotoGrid.innerHTML = '';
  }

  el.btnSaveGroup.disabled = wCount === 0 || pCount === 0;
}

el.draftWaybillList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-idx]');
  if (!btn) return;
  const idx = Number(btn.dataset.removeIdx);
  state.draft.waybills.splice(idx, 1);
  renderDraftUI();
  persistDraftState();
});

// --- Zoom Foto & Integrasi Tombol Back Android ---
function openPhotoZoom(photoObj, recipient, filename) {
  el.zoomedImg.src = getBlobUrl(photoObj.blob);
  const timeStr = formatTimestamp(photoObj.timestamp);
  const parts = [
    `Waktu: ${timeStr}`,
    recipient ? `Penerima: ${recipient}` : '',
    photoObj.gpsText ? `GPS: ${photoObj.gpsText}` : ''
  ].filter(Boolean);
  el.zoomMetaOverlay.textContent = parts.join(' • ');
  state.zoomedPhoto = { blob: photoObj.blob, filename };

  if (el.photoZoomModal.classList.contains('hidden')) {
    el.photoZoomModal.classList.remove('hidden');
    history.pushState({ modal: 'photoZoom' }, '');
  }
}

function hidePhotoZoomUI() {
  el.photoZoomModal.classList.add('hidden');
  state.zoomedPhoto = null;
}

function requestClosePhotoZoom() {
  if (el.photoZoomModal.classList.contains('hidden')) return;
  if (history.state && history.state.modal === 'photoZoom') {
    history.back();
  } else {
    hidePhotoZoomUI();
  }
}

window.addEventListener('popstate', () => {
  if (!el.photoZoomModal.classList.contains('hidden')) {
    hidePhotoZoomUI();
  }
});

el.zoomBackdropArea.addEventListener('click', (e) => {
  if (e.target === el.zoomBackdropArea) {
    requestClosePhotoZoom();
  }
});

el.draftPhotoGrid.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove-photo-idx]');
  if (removeBtn) {
    const idx = Number(removeBtn.dataset.removePhotoIdx);
    state.draft.photos.splice(idx, 1);
    renderDraftUI();
    persistDraftState();
    return;
  }

  const zoomImg = e.target.closest('[data-zoom-draft-idx]');
  if (zoomImg) {
    const idx = Number(zoomImg.dataset.zoomDraftIdx);
    const photo = state.draft.photos[idx];
    if (photo) {
      openPhotoZoom(photo, state.draft.recipient.trim(), `TTD_draft_${idx + 1}.jpg`);
    }
  }
});

el.btnClearDraftPhotos.addEventListener('click', () => {
  state.draft.photos = [];
  renderDraftUI();
  persistDraftState();
});

el.toggleLockMode.addEventListener('change', () => {
  state.lockMode = el.toggleLockMode.checked;
  if (!state.lockMode) {
    if (state.draft.waybills.length > 1) {
      state.draft.waybills = [state.draft.waybills[0]];
    }
    if (state.draft.photos.length > 1) {
      state.draft.photos = [state.draft.photos[0]];
    }
  }
  renderDraftUI();
  persistDraftState();
});

el.inputRecipient.addEventListener('input', () => {
  state.draft.recipient = el.inputRecipient.value;
  persistDraftState();
});

el.btnPasteWaybill.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      addWaybillToDraft(text);
    }
  } catch (_) {
    showToast('Izin clipboard ditolak browser, tempel manual di kolom.');
  }
});

el.btnAddManualWaybill.addEventListener('click', () => {
  if (addWaybillToDraft(el.inputManualWaybill.value)) {
    el.inputManualWaybill.value = '';
  }
});

el.inputManualWaybill.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.btnAddManualWaybill.click();
  }
});

// --- Scan Resi dari Galeri (Single & Batch Multi-File) ---
el.inputScanGallery.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;

  el.galleryScanStatus.classList.remove('hidden');

  if (files.length === 1) {
    el.galleryScanStatus.textContent = 'Memproses gambar...';
    try {
      const res = await scanWaybillFromImageFile(files[0], (msg) => {
        el.galleryScanStatus.textContent = msg;
      });
      addWaybillToDraft(res.waybill);
      el.galleryScanStatus.textContent = `Berhasil (${res.method}): ${res.waybill}`;
      setTimeout(() => el.galleryScanStatus.classList.add('hidden'), 3000);
    } catch (err) {
      el.galleryScanStatus.textContent = err.message;
    }
    return;
  }

  let successCount = 0;
  let failCount = 0;
  for (let i = 0; i < files.length; i++) {
    el.galleryScanStatus.textContent = `Memindai foto ${i + 1} dari ${files.length}...`;
    try {
      const res = await scanWaybillFromImageFile(files[i]);
      if (addWaybillToDraft(res.waybill)) {
        successCount++;
      }
    } catch (_) {
      failCount++;
    }
  }

  el.galleryScanStatus.textContent =
    failCount > 0
      ? `Selesai: ${successCount} resi terbaca, ${failCount} foto gagal terbaca.`
      : `Berhasil membaca ${successCount} resi dari galeri.`;
  setTimeout(() => el.galleryScanStatus.classList.add('hidden'), 4000);
});

// --- Ambil Foto Kamera / Pilih Multi-Foto dari Galeri ---
async function handlePodPhotosSelection(fileList, isFromGallery) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  if (files.length > 1 && !state.lockMode) {
    state.lockMode = true;
    el.toggleLockMode.checked = true;
  }

  showToast(`Menyimpan ${files.length} foto...`);

  const processedItems = [];
  for (const file of files) {
    const captureTime = isFromGallery && file.lastModified ? file.lastModified : Date.now();
    const processed = await processPodImage(file, {
      captureTimestamp: captureTime,
      includeGps: !isFromGallery
    });
    processedItems.push({
      id: crypto.randomUUID(),
      blob: processed.blob,
      timestamp: processed.timestamp,
      gpsText: processed.gpsText
    });
  }

  if (state.lockMode) {
    state.draft.photos.push(...processedItems);
  } else {
    state.draft.photos = [processedItems[0]];
  }

  renderDraftUI();
  await persistDraftState();
  showToast(`${state.draft.photos.length} foto siap disimpan.`);
}

el.inputCameraPhoto.addEventListener('change', (e) => {
  handlePodPhotosSelection(e.target.files, false);
  e.target.value = '';
});

el.inputGalleryPhoto.addEventListener('change', (e) => {
  handlePodPhotosSelection(e.target.files, true);
  e.target.value = '';
});

// --- Simpan Grup ke IndexedDB ---
el.btnSaveGroup.addEventListener('click', async () => {
  if (state.draft.waybills.length === 0 || state.draft.photos.length === 0) return;

  const newGroup = {
    id: crypto.randomUUID(),
    status: 'PENDING',
    recipient: state.draft.recipient.trim(),
    photos: state.draft.photos.map((p) => ({
      id: p.id,
      blob: p.blob,
      timestamp: p.timestamp,
      gpsText: p.gpsText || ''
    })),
    createdAt: state.draft.photos[0]?.timestamp || Date.now(),
    completedAt: null,
    waybills: state.draft.waybills.map((code) => ({
      code,
      copied: false
    }))
  };

  await saveGroup(newGroup);

  state.draft = {
    waybills: [],
    recipient: '',
    photos: []
  };
  el.inputRecipient.value = '';
  await persistDraftState();
  renderDraftUI();
  await refreshGroups();
  showToast(`${newGroup.waybills.length} resi tersimpan ke Pending TTD!`);
});

// --- Live Hybrid Scanner (Kamera + BarcodeDetector + OCR) ---
async function openLiveScanner() {
  el.scannerModal.classList.remove('hidden');
  el.scannerStatusText.textContent = 'Membuka kamera belakang...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    state.scannerStream = stream;
    el.scannerVideo.srcObject = stream;
    await el.scannerVideo.play();

    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      el.btnToggleTorch.classList.remove('hidden');
    }

    startBarcodeDetectionLoop();
  } catch (err) {
    el.scannerStatusText.textContent =
      'Kamera gagal dibuka. Gunakan Scan dari Galeri / Input Manual.';
  }
}

function startBarcodeDetectionLoop() {
  if (!('BarcodeDetector' in window)) {
    el.scannerStatusText.textContent =
      'Browser tidak mendukung auto-barcode, gunakan tombol OCR di bawah.';
    return;
  }

  const detector = new window.BarcodeDetector({
    formats: ['code_128', 'qr_code', 'code_39', 'ean_13']
  });

  el.scannerStatusText.textContent = state.lockMode
    ? 'Mode Lock Aktif: Scan semua paket penerima ini beruntun'
    : 'Arahkan kotak merah ke barcode / QR resi';

  const scanFrame = async () => {
    if (!state.scannerStream) return;
    try {
      if (el.scannerVideo.readyState >= 2) {
        const barcodes = await detector.detect(el.scannerVideo);
        for (const item of barcodes) {
          const code = extractJntWaybill(item.rawValue);
          const now = Date.now();
          if (code && (code !== state.lastScanCode || now - state.lastScanTime > 2500)) {
            state.lastScanCode = code;
            state.lastScanTime = now;
            const added = addWaybillToDraft(code);
            if (added && !state.lockMode) {
              closeLiveScanner();
              return;
            }
          }
        }
      }
    } catch (_) {}
    state.scannerRaf = requestAnimationFrame(scanFrame);
  };

  state.scannerRaf = requestAnimationFrame(scanFrame);
}

function closeLiveScanner() {
  cancelAnimationFrame(state.scannerRaf);
  if (state.scannerStream) {
    state.scannerStream.getTracks().forEach((t) => t.stop());
    state.scannerStream = null;
  }
  el.scannerVideo.srcObject = null;
  el.btnToggleTorch.classList.add('hidden');
  state.torchOn = false;
  el.scannerModal.classList.add('hidden');
}

el.btnOpenScanner.addEventListener('click', openLiveScanner);
el.btnCloseScanner.addEventListener('click', closeLiveScanner);

el.btnToggleTorch.addEventListener('click', async () => {
  if (!state.scannerStream) return;
  const track = state.scannerStream.getVideoTracks()[0];
  state.torchOn = !state.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    el.btnToggleTorch.textContent = state.torchOn ? 'Senter ON' : 'Senter';
  } catch (_) {}
});

el.btnCaptureOcr.addEventListener('click', async () => {
  if (!el.scannerVideo.videoWidth) return;
  el.btnCaptureOcr.disabled = true;
  el.btnCaptureOcr.textContent = 'Membaca teks...';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = el.scannerVideo.videoWidth;
    canvas.height = el.scannerVideo.videoHeight;
    canvas.getContext('2d').drawImage(el.scannerVideo, 0, 0);

    const res = await runOcrOnImageSource(canvas);
    if (res.waybill) {
      const added = addWaybillToDraft(res.waybill);
      if (added && !state.lockMode) closeLiveScanner();
    } else {
      showToast('Teks resi belum terbaca jelas, dekatkan kamera ke tulisan resi.');
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    el.btnCaptureOcr.disabled = false;
    el.btnCaptureOcr.textContent = 'Baca Teks Resi (OCR)';
  }
});

// --- Daftar Pending & Selesai ---
async function refreshGroups() {
  state.groups = await getAllGroups();
  const pendingCount = state.groups.filter((g) => g.status === 'PENDING').length;
  const doneCount = state.groups.filter((g) => g.status === 'DONE').length;

  el.headerPendingCount.textContent = pendingCount;
  el.navPendingBadge.textContent = pendingCount;
  el.navDoneBadge.textContent = doneCount;

  if (state.activeTab !== 'INPUT') {
    renderGroupCards();
  }
}

function renderGroupCards() {
  const query = el.inputSearchResi.value.trim().toUpperCase();
  const filtered = state.groups.filter((g) => {
    if (g.status !== state.activeTab) return false;
    if (!query) return true;
    const matchWaybill = g.waybills.some((w) => w.code.includes(query));
    const matchRecipient = (g.recipient || '').toUpperCase().includes(query);
    return matchWaybill || matchRecipient;
  });

  if (filtered.length === 0) {
    el.groupCardsContainer.innerHTML = `
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-8 text-center">
        <p class="text-sm font-semibold text-slate-400">
          ${state.activeTab === 'PENDING' ? 'Tidak ada antrean Pending TTD.' : 'Belum ada riwayat selesai.'}
        </p>
      </div>`;
    return;
  }

  el.groupCardsContainer.innerHTML = filtered
    .map((group) => {
      const photos = getGroupPhotos(group);
      const isActiveCard = group.id === state.activeGroupId && group.status === 'PENDING';

      const dateStr = new Date(group.createdAt).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      const firstUncopiedIdx = group.waybills.findIndex((w) => !w.copied);

      const waybillRows = group.waybills
        .map((w, idx) => {
          const isNextTarget =
            group.status === 'PENDING' && !w.copied && idx === firstUncopiedIdx;
          return `
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border ${
            w.copied
              ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'
              : isNextTarget
              ? 'bg-slate-950 border-amber-500/70 text-white'
              : 'bg-slate-950 border-slate-800 text-slate-200'
          }">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs font-bold ${w.copied ? 'text-emerald-400' : 'text-slate-500'}">
                ${w.copied ? '✓' : `${idx + 1}.`}
              </span>
              <span class="font-mono font-bold text-sm truncate">${w.code}</span>
            </div>
            <button type="button" data-action="copy-waybill" data-group-id="${group.id}" data-idx="${idx}"
              class="px-3 py-1.5 rounded-lg text-xs font-bold shrink-0 active:scale-95 transition ${
                w.copied
                  ? 'bg-emerald-800/50 text-emerald-200'
                  : 'bg-red-600 hover:bg-red-500 text-white'
              }">
              ${w.copied ? 'Disalin ✓' : 'Salin Resi'}
            </button>
          </div>`;
        })
        .join('');

      // Thumbnail Foto Penerima dengan UI Overlay Jam
      const photoGalleryHtml =
        photos.length > 0
          ? `<div class="grid ${photos.length === 1 ? 'grid-cols-2' : 'grid-cols-3'} gap-2">
              ${photos
                .map((p, pIdx) => {
                  const url = getBlobUrl(p.blob);
                  const jam = new Date(p.timestamp).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit'
                  });
                  return `
                  <div class="relative aspect-square rounded-xl overflow-hidden border border-slate-700 bg-slate-950">
                    <img src="${url}" data-action="zoom-photo" data-group-id="${group.id}" data-photo-idx="${pIdx}" alt="Foto ${pIdx + 1}"
                      class="w-full h-full object-cover cursor-pointer" />
                    <div class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2 py-1.5">
                      <span class="text-[10px] font-bold text-white block leading-tight">
                        #${pIdx + 1} • ${jam}
                      </span>
                    </div>
                  </div>`;
                })
                .join('')}
            </div>`
          : '';

      return `
      <article id="card-${group.id}" class="bg-slate-900 rounded-2xl p-4 space-y-3 border-2 transition ${
        isActiveCard
          ? 'border-amber-500 shadow-lg shadow-amber-950/30'
          : 'border-slate-800'
      }">
        <!-- Header Kartu -->
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="px-2 py-0.5 rounded-md text-[11px] font-bold ${
                group.waybills.length > 1 || photos.length > 1
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-slate-800 text-slate-300'
              }">
                ${group.waybills.length} Paket • ${photos.length} Foto
              </span>
              <span class="text-[11px] text-slate-400">${dateStr}</span>
            </div>
            <p class="text-sm font-bold text-white truncate mt-1">
              ${group.recipient || 'Tanpa Nama Penerima'}
            </p>
          </div>
        </div>

        <!-- Thumbnail Foto Pengingat -->
        ${photoGalleryHtml}

        <!-- Daftar Resi dalam Grup -->
        <div class="space-y-2">
          ${waybillRows}
        </div>

        <!-- Footer Aksi Kartu -->
        <div class="pt-1 flex items-center justify-between gap-2">
          <button type="button" data-action="delete-group" data-group-id="${group.id}"
            class="px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-400">
            Hapus
          </button>

          ${
            group.status === 'PENDING'
              ? `<button type="button" data-action="mark-done" data-group-id="${group.id}"
                  class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 text-slate-300 border border-slate-700 active:scale-95 transition">
                  Tandai Selesai
                </button>`
              : `<button type="button" data-action="reopen-group" data-group-id="${group.id}"
                  class="px-3 py-1.5 rounded-xl bg-slate-800 text-xs font-semibold text-amber-300 border border-slate-700">
                  Kembalikan ke Pending
                </button>`
          }
        </div>
      </article>`;
    })
    .join('');
}

// Evaluasi Auto-Selesai saat semua resi dalam grup disalin (hanya jika sakelar aktif)
async function evaluateAutoComplete(group) {
  const allCopied = group.waybills.every((w) => w.copied);
  if (state.autoCompleteMode && allCopied && group.status === 'PENDING') {
    const prevSnapshot = structuredClone(group);
    group.status = 'DONE';
    group.completedAt = Date.now();
    await saveGroup(group);
    await refreshGroups();

    showToast('Semua resi disalin -> Selesai!', async () => {
      await saveGroup(prevSnapshot);
      await refreshGroups();
    });
  }
}

// Event Delegation pada Daftar Kartu
el.groupCardsContainer.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const groupId = target.dataset.groupId;
  const group = await getGroupById(groupId);
  if (!group) return;

  if (action === 'copy-waybill') {
    const idx = Number(target.dataset.idx);
    const waybillObj = group.waybills[idx];
    if (!waybillObj) return;

    await navigator.clipboard.writeText(waybillObj.code);
    waybillObj.copied = true;
    state.activeGroupId = group.id;
    await saveMeta('last_active_group_id', group.id);
    await saveGroup(group);
    await refreshGroups();
    showToast(`Tersalin: ${waybillObj.code}`);
    await evaluateAutoComplete(group);
  }

  if (action === 'zoom-photo') {
    const photos = getGroupPhotos(group);
    const pIdx = Number(target.dataset.photoIdx);
    const photoObj = photos[pIdx];
    if (!photoObj?.blob) return;
    const firstCode = group.waybills[0]?.code || 'TTD';
    openPhotoZoom(photoObj, group.recipient, `TTD_${firstCode}_${pIdx + 1}.jpg`);
  }

  if (action === 'mark-done') {
    const prevSnapshot = structuredClone(group);
    group.status = 'DONE';
    group.completedAt = Date.now();
    await saveGroup(group);
    await refreshGroups();
    showToast('Dipindahkan ke Selesai.', async () => {
      await saveGroup(prevSnapshot);
      await refreshGroups();
    });
  }

  if (action === 'reopen-group') {
    group.status = 'PENDING';
    group.completedAt = null;
    await saveGroup(group);
    await refreshGroups();
    showToast('Dikembalikan ke daftar Pending.');
  }

  if (action === 'delete-group') {
    await deleteGroup(group.id);
    await refreshGroups();
    showToast('Data dihapus.');
  }
});

el.btnDownloadZoomed.addEventListener('click', () => {
  if (!state.zoomedPhoto?.blob) return;
  const url = URL.createObjectURL(state.zoomedPhoto.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.zoomedPhoto.filename || 'foto_ttd.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast('Foto bersih disimpan ke galeri.');
});

el.toggleAutoComplete.addEventListener('change', async () => {
  state.autoCompleteMode = el.toggleAutoComplete.checked;
  await saveMeta('auto_complete_mode', state.autoCompleteMode);
  showToast(
    state.autoCompleteMode ? 'Mode Auto-Selesai AKTIF' : 'Mode Manual AKTIF'
  );
});

el.inputSearchResi.addEventListener('input', renderGroupCards);

// --- Export Rekap Teks ---
el.btnExportText.addEventListener('click', async () => {
  const pending = state.groups.filter((g) => g.status === 'PENDING');
  if (pending.length === 0) {
    showToast('Tidak ada resi Pending untuk direkap.');
    return;
  }

  const lines = ['*REKAP PENDING TTD*'];
  let totalPaket = 0;
  pending.forEach((g, i) => {
    const codes = g.waybills.map((w) => w.code).join(', ');
    totalPaket += g.waybills.length;
    const ket = g.recipient ? ` (${g.recipient})` : '';
    lines.push(`${i + 1}. ${codes}${ket}`);
  });
  lines.push(`\nTotal: ${totalPaket} Paket (${pending.length} Penerima)`);

  await navigator.clipboard.writeText(lines.join('\n'));
  showToast(`Rekap ${totalPaket} resi disalin ke clipboard!`);
});

// --- Navigasi Tab ---
function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.className = `nav-tab py-3 flex flex-col items-center gap-0.5 text-xs border-t-2 transition ${
      active
        ? 'text-red-400 font-bold border-red-500'
        : 'text-slate-400 font-semibold border-transparent'
    }`;
  });

  if (tabName === 'INPUT') {
    el.viewInput.classList.remove('hidden');
    el.viewList.classList.add('hidden');
  } else {
    el.viewInput.classList.add('hidden');
    el.viewList.classList.remove('hidden');
    renderGroupCards();

    if (tabName === 'PENDING' && state.activeGroupId) {
      setTimeout(() => {
        document
          .getElementById(`card-${state.activeGroupId}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }
}

document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// --- Inisialisasi Aplikasi ---
(async function init() {
  updateNetworkStatus();
  await initStoragePersistence();
  await cleanupOldDoneGroups(14);
  await restoreAppState();
  await refreshGroups();
})();
