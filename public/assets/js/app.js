/* =========================================================
   SiramIn — logika dashboard
   Alur data:
     ESP32 --MQTT--> Backend --SSE /stream--> dashboard (realtime)
     dashboard --POST /commands--> Backend --MQTT--> ESP32
   ========================================================= */
(() => {
  'use strict';

  // ---------- Konfigurasi ----------
  const CFG = Object.assign(
    { apiBase: '', batasKering: 30, batasBasah: 60, batasSuhu: 35, batasManual: 30 },
    window.SIRAM_CONFIG || {},
  );
  const API = CFG.apiBase.replace(/\/+$/, '') + '/api';
  const ONLINE_MS = 10_000;        // sama dengan backend: > 10 dtk tanpa data = offline
  const CONFIRM_TIMEOUT = 12_000;  // batas tunggu konfirmasi ESP32 setelah perintah
  const PAGE_SIZE = 10;

  // ---------- State ----------
  const S = {
    deviceId: null,
    devices: [],
    readings: [],        // terbaru di depan
    commands: [],
    latest: null,
    health: null,
    clockOffset: 0,      // waktu server - waktu browser (ms)
    range: 150,
    statsHours: 24,
    tab: 'readings',
    page: 1,
    total: 0,
    hidden: [false, false, false],
    pending: null,       // perintah yang menunggu konfirmasi ESP32
    es: null,
    streamOk: false,
    lastEventAt: 0,
  };

  // ---------- Helper ----------
  const $ = (id) => document.getElementById(id);
  const now = () => Date.now() + S.clockOffset;
  const ts = (s) => new Date(s).getTime();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d).replace(/\.0$/, ''));
  const fmtTime = (s) => new Date(s).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDateTime = (s) => new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = (s) => {
    const sec = Math.max(0, Math.round((now() - ts(s)) / 1000));
    if (sec < 5) return 'baru saja';
    if (sec < 60) return `${sec} dtk lalu`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} mnt lalu`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} jam lalu`;
    return `${Math.floor(h / 24)} hari lalu`;
  };
  const isOnline = () => !!S.latest && now() - ts(S.latest.created_at) < ONLINE_MS;

  class ApiError extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status; }
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        ...opts,
        headers: opts.body ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
      });
    } catch {
      throw new ApiError('NETWORK', 'Tidak dapat terhubung ke backend. Periksa koneksi internet / server.', 0);
    }
    let json;
    try { json = await res.json(); } catch { throw new ApiError('BAD_RESPONSE', `Respons backend tidak valid (HTTP ${res.status})`, res.status); }
    if (!json.success) throw new ApiError(json.error?.code || 'ERROR', json.error?.message || 'Terjadi kesalahan', res.status);
    return json;
  }

  const store = {
    get(k) { try { return localStorage.getItem('siram-' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('siram-' + k, v); } catch {} },
  };

  function toast(title, text = '', tone = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.tone = tone;
    el.innerHTML = `<span class="t-dot"></span><div><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 4200);
  }

  function setChip(id, state, text) {
    const el = $(id);
    el.dataset.state = state;
    el.querySelector('span').textContent = text;
  }

  // ---------- Kondisi tanaman ----------
  function soilState(v) {
    if (v == null) return { key: 'none', color: 'var(--muted)' };
    if (v < CFG.batasKering) return { key: 'dry', color: 'var(--warn)', title: 'Tanah kering', desc: 'Kelembapan di bawah ambang. Pada mode otomatis, pompa menyala untuk menyiram.' };
    if (v < CFG.batasBasah) return { key: 'ok', color: 'var(--ok)', title: 'Kelembapan cukup', desc: 'Kondisi tanah ideal. Status pompa dipertahankan (histeresis) agar tidak hidup-mati berulang.' };
    return { key: 'wet', color: 'var(--info)', title: 'Tanah basah', desc: 'Tanah sudah cukup basah. Pada mode otomatis, pompa dimatikan.' };
  }

  // Waktu mulai mode MANUAL = data MANUAL tertua dalam rangkaian MANUAL terakhir
  function manualStart() {
    if (S.latest?.mode !== 'MANUAL') return null;
    let start = S.latest.created_at;
    for (const r of S.readings) {
      if (r.mode !== 'MANUAL') break;
      start = r.created_at;
    }
    // jika perintah MANUAL dikirim dari dashboard setelahnya, pakai waktu perintah itu
    const cmd = S.commands.find((c) => c.command === 'MODE_MANUAL');
    if (cmd && ts(cmd.created_at) > ts(start) - 3000 && ts(cmd.created_at) <= ts(S.latest.created_at)) start = cmd.created_at;
    return ts(start);
  }

  // ---------- Render: data live ----------
  function renderLive() {
    const r = S.latest;
    document.body.classList.remove('is-loading-data');

    // Gauge + kondisi tanah
    const soil = r?.soil_moisture ?? null;
    const st = soilState(soil);
    const plant = document.querySelector('.plant');
    plant.style.setProperty('--state', st.color);
    $('gauge').style.setProperty('--state', st.color);
    $('soil-value').textContent = soil ?? '–';
    $('gauge-fill').style.strokeDashoffset = 326.73 * (1 - (soil ?? 0) / 100);
    $('gauge').setAttribute('aria-label', `Kelembapan tanah ${soil ?? 'tidak diketahui'} persen`);
    $('zone-marker').style.left = `${soil ?? 0}%`;
    if (r) {
      $('plant-title').textContent = st.title;
      $('plant-desc').textContent = r.pump_on ? `${st.desc.split('.')[0]}. Pompa sedang menyiram tanaman.` : st.desc;
    }

    // Suhu
    const hot = r?.temperature != null && r.temperature > CFG.batasSuhu;
    if (r && r.temperature == null) {
      $('temp-value').textContent = 'Error';
      $('temp-sub').textContent = 'Sensor DHT22 gagal dibaca';
      $('m-temp').dataset.state = 'alert';
    } else {
      $('temp-value').textContent = num(r?.temperature);
      $('temp-sub').textContent = hot ? `Di atas batas ${CFG.batasSuhu}°C!` : 'DHT22';
      $('m-temp').dataset.state = hot ? 'alert' : '';
    }
    $('hum-value').textContent = r?.air_humidity == null ? '–' : Math.round(r.air_humidity);

    // Aktuator (status pompa dari telemetry; katup & buzzer mengikuti logika firmware)
    const pump = r?.pump_on;
    $('pump-value').textContent = r ? (pump ? 'Menyala' : 'Mati') : '–';
    $('m-pump').dataset.state = pump ? 'on' : '';
    $('valve-value').textContent = r ? (pump ? 'Terbuka' : 'Tertutup') : '–';
    $('valve-sub').textContent = r ? `Servo ${pump ? '90°' : '0°'} · GPIO 18` : 'Servo · GPIO 18';
    $('m-valve').dataset.state = pump ? 'on' : '';
    $('buzzer-value').textContent = r ? (hot ? 'Berbunyi' : 'Senyap') : '–';
    $('m-buzzer').dataset.state = hot ? 'alert' : '';

    // Mode
    const mode = r?.mode ?? null;
    $('mode-badge').textContent = mode ? `Mode ${mode}` : 'Tidak ada data';
    $('mode-badge').dataset.mode = mode ?? '';
    $('btn-auto').setAttribute('aria-pressed', mode === 'AUTO');
    $('btn-manual').setAttribute('aria-pressed', mode === 'MANUAL');
    $('btn-manual').querySelector('strong').textContent = mode === 'MANUAL' ? 'Ulangi siram' : 'Siram manual';

    renderTick();
  }

  // Dipanggil tiap detik: status online, waktu relatif, hitung mundur
  function renderTick() {
    const online = isOnline();
    const r = S.latest;
    setChip('chip-device', online ? 'ok' : 'bad', online ? 'ESP32 online' : 'ESP32 offline');
    $('last-update').textContent = r ? `Data terakhir ${ago(r.created_at)} · ${fmtTime(r.created_at)}` : 'Belum ada data';

    // Banner peringatan
    const b = $('banner');
    if (S.health === false) {
      b.hidden = false; b.dataset.tone = 'bad';
      $('banner-title').textContent = 'Backend tidak dapat dihubungi';
      $('banner-text').textContent = 'Dashboard akan mencoba lagi secara otomatis.';
    } else if (S.health && !S.health.mqtt.connected) {
      b.hidden = false; b.dataset.tone = 'bad';
      $('banner-title').textContent = 'Backend terputus dari broker MQTT';
      $('banner-text').textContent = 'Perintah tidak dapat dikirim dan data baru tidak diterima sampai koneksi pulih.';
    } else if (S.deviceId && !online) {
      b.hidden = false; b.dataset.tone = 'warn';
      $('banner-title').textContent = 'ESP32 sedang offline';
      $('banner-text').textContent = r
        ? `Tidak ada data sejak ${fmtDateTime(r.created_at)}. Jalankan simulasi Wokwi untuk melihat data realtime. Data di bawah adalah riwayat terakhir.`
        : 'Belum ada data dari perangkat ini. Jalankan simulasi Wokwi terlebih dahulu.';
    } else {
      b.hidden = true;
    }

    // Hitung mundur mode MANUAL
    const start = manualStart();
    const cd = $('countdown');
    if (start && online) {
      const total = CFG.batasManual;
      const left = Math.max(0, Math.ceil(total - (now() - start) / 1000));
      cd.hidden = false;
      $('countdown-text').textContent = left > 0 ? `${left} dtk lagi` : 'kembali ke AUTO…';
      $('countdown-bar').style.width = `${(left / total) * 100}%`;
    } else {
      cd.hidden = true;
    }

    // Timeout konfirmasi perintah
    const p = S.pending;
    if (p && Date.now() - p.sentAt > CONFIRM_TIMEOUT) {
      S.pending = null;
      setFeedback('warn', 'ESP32 tidak merespons',
        `Perintah ${label(p.command)} tersimpan & terkirim ke broker, tetapi ESP32 tidak mengonfirmasi. Pastikan simulasi Wokwi berjalan.`);
      toast('Tidak ada konfirmasi dari ESP32', 'Periksa apakah simulasi Wokwi berjalan.', 'warn');
      setBusy(false);
    }
  }

  // ---------- Kontrol / perintah ----------
  const label = (cmd) => (cmd === 'MODE_AUTO' ? 'mode OTOMATIS' : 'SIRAM MANUAL');

  function setFeedback(state, title, text) {
    $('feedback').dataset.state = state;
    $('feedback-title').textContent = title;
    $('feedback-text').textContent = text;
  }

  function setBusy(cmd) {
    for (const b of document.querySelectorAll('[data-cmd]')) {
      b.disabled = !!cmd;
      b.classList.toggle('is-loading', b.dataset.cmd === cmd);
    }
  }

  async function sendCommand(command) {
    if (!S.deviceId || S.pending) return;
    setBusy(command);
    setFeedback('sending', 'Mengirim perintah…', `${label(command)} → backend → MQTT → ESP32`);
    try {
      const { data } = await api(`/devices/${encodeURIComponent(S.deviceId)}/commands`, {
        method: 'POST',
        body: JSON.stringify({ command }),
      });
      S.commands.unshift(data);
      renderTimeline();
      if (S.tab === 'commands') loadHistory();

      if (!isOnline()) {
        setFeedback('warn', 'Terkirim, tetapi ESP32 offline',
          `Perintah ${label(command)} tercatat di database, namun ESP32 tidak sedang online sehingga tidak akan diterima.`);
        toast('Perintah terkirim, ESP32 offline', 'Jalankan simulasi Wokwi lalu coba lagi.', 'warn');
        setBusy(false);
        return;
      }
      S.pending = { command, expect: command === 'MODE_AUTO' ? 'AUTO' : 'MANUAL', sentAt: Date.now(), serverAt: ts(data.created_at) };
      setFeedback('waiting', 'Terkirim — menunggu konfirmasi ESP32…', `Perintah #${data.id} diterima backend pukul ${fmtTime(data.created_at)}.`);
    } catch (e) {
      const msg = e.code === 'MQTT_UNAVAILABLE'
        ? 'Backend tidak terhubung ke broker MQTT, perintah tidak terkirim.'
        : e.message;
      setFeedback('error', 'Perintah gagal', msg);
      toast('Perintah gagal', msg, 'bad');
      setBusy(false);
    }
  }

  function checkConfirmation(r) {
    const p = S.pending;
    if (!p || ts(r.created_at) < p.serverAt) return;
    if (r.mode === p.expect) {
      S.pending = null;
      setBusy(false);
      const lat = ((ts(r.created_at) - p.serverAt) / 1000).toFixed(1);
      const txt = p.expect === 'MANUAL'
        ? `ESP32 masuk mode MANUAL: pompa & katup aktif selama ${CFG.batasManual} detik (respons ${lat} dtk).`
        : `ESP32 kembali ke mode OTOMATIS (respons ${lat} dtk).`;
      setFeedback('success', 'Berhasil — dikonfirmasi ESP32', txt);
      toast('Perintah berhasil', txt, 'ok');
    }
  }

  // ---------- Grafik ----------
  let chart;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const thresholdPlugin = {
    id: 'thresholds',
    afterDatasetsDraw(c) {
      if (S.hidden[0]) return;
      const { ctx, chartArea: a, scales: { y } } = c;
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1;
      ctx.font = '600 11px "Plus Jakarta Sans", system-ui, sans-serif';
      for (const [val, color, text] of [[CFG.batasKering, css('--warn'), `Kering ${CFG.batasKering}%`], [CFG.batasBasah, css('--info'), `Basah ${CFG.batasBasah}%`]]) {
        const yy = y.getPixelForValue(val);
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(a.left, yy); ctx.lineTo(a.right, yy); ctx.stroke();
        ctx.fillText(text, a.left + 6, yy - 5);
      }
      ctx.restore();
    },
  };

  function chartData() {
    const pts = S.readings.slice(0, S.range).reverse();
    return {
      labels: pts.map((r) => fmtTime(r.created_at)),
      soil: pts.map((r) => r.soil_moisture),
      temp: pts.map((r) => r.temperature),
      hum: pts.map((r) => r.air_humidity),
    };
  }

  function renderChart() {
    $('chart-empty').hidden = S.readings.length > 0;
    if (!window.Chart) return;
    const d = chartData();
    const grid = css('--line');
    const tick = css('--muted');

    if (!chart) {
      Chart.defaults.font.family = '"Plus Jakarta Sans", system-ui, sans-serif';
      chart = new Chart($('chart'), {
        type: 'line',
        data: {
          labels: d.labels,
          datasets: [
            { label: 'Kelembapan tanah (%)', data: d.soil, yAxisID: 'y', fill: true, borderWidth: 2.2 },
            { label: 'Suhu (°C)', data: d.temp, yAxisID: 'y1', borderWidth: 2 },
            { label: 'Kelembapan udara (%)', data: d.hum, yAxisID: 'y', borderWidth: 1.6, borderDash: [4, 4] },
          ],
        },
        options: {
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          elements: { point: { radius: 0, hoverRadius: 4 }, line: { tension: 0.35 } },
          plugins: {
            legend: { display: false },
            tooltip: { padding: 10, cornerRadius: 10, boxPadding: 4, usePointStyle: true },
          },
          scales: {
            x: { ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true }, grid: { display: false } },
            y: { min: 0, max: 100, ticks: { stepSize: 20, callback: (v) => v + '%' }, title: { display: false } },
            y1: { position: 'right', suggestedMin: 15, suggestedMax: 45, grid: { drawOnChartArea: false }, ticks: { callback: (v) => v + '°' } },
          },
        },
        plugins: [thresholdPlugin],
      });
    } else {
      chart.data.labels = d.labels;
      chart.data.datasets[0].data = d.soil;
      chart.data.datasets[1].data = d.temp;
      chart.data.datasets[2].data = d.hum;
    }
    applyChartTheme();
    S.hidden.forEach((h, i) => chart.setDatasetVisibility(i, !h));
    chart.update('none');

    function applyChartTheme() {
      const soil = css('--c-soil'), temp = css('--c-temp'), hum = css('--c-hum');
      const [a, b, c] = chart.data.datasets;
      a.borderColor = soil; a.backgroundColor = soil + '1f';
      b.borderColor = temp; b.backgroundColor = temp;
      c.borderColor = hum; c.backgroundColor = hum;
      for (const s of Object.values(chart.options.scales)) {
        s.ticks.color = tick; s.grid.color = grid; s.border = { color: grid };
      }
      chart.options.plugins.tooltip.backgroundColor = css('--text');
      chart.options.plugins.tooltip.titleColor = css('--bg');
      chart.options.plugins.tooltip.bodyColor = css('--bg');
    }
  }

  // ---------- Statistik ----------
  async function loadStats() {
    if (!S.deviceId) return;
    try {
      const { data: s } = await api(`/devices/${encodeURIComponent(S.deviceId)}/stats?hours=${S.statsHours}`);
      const has = s.count > 0;
      $('s-soil-avg').textContent = has ? `${num(s.soil_avg)}%` : '–';
      $('s-soil-range').textContent = has ? `min ${s.soil_min}% · maks ${s.soil_max}%` : 'tidak ada data';
      $('s-temp-avg').textContent = has && s.temp_avg != null ? `${num(s.temp_avg)}°C` : '–';
      $('s-temp-range').textContent = has && s.temp_min != null ? `min ${num(s.temp_min)}° · maks ${num(s.temp_max)}°` : 'tidak ada data';
      $('s-hum-avg').textContent = has && s.humidity_avg != null ? `${num(s.humidity_avg)}%` : '–';
      $('s-pump').textContent = has ? `${num(s.pump_on_percent)}%` : '–';
      $('s-pump-bar').style.width = `${has ? s.pump_on_percent : 0}%`;
      const rangeTxt = { 1: '1 jam', 24: '24 jam', 168: '7 hari' }[S.statsHours];
      $('s-count').textContent = has
        ? `Dihitung dari ${s.count.toLocaleString('id-ID')} data sensor dalam ${rangeTxt} terakhir.`
        : `Tidak ada data sensor dalam ${rangeTxt} terakhir.`;
    } catch (e) {
      $('s-count').textContent = 'Gagal memuat statistik: ' + e.message;
    }
  }

  // ---------- Log kejadian (dari perubahan data + riwayat perintah) ----------
  const ICONS = {
    drop: '<svg viewBox="0 0 24 24"><path d="M12 2.5c-3.6 4.5-6.5 8-6.5 11.6a6.5 6.5 0 0 0 13 0C18.5 10.5 15.6 7 12 2.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    mode: '<svg viewBox="0 0 24 24"><path d="M4 7h11M4 17h7M17 4l3 3-3 3M13 14l3 3-3 3"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    hot: '<svg viewBox="0 0 24 24"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/></svg>',
  };

  function buildEvents() {
    const ev = [];
    const rs = S.readings; // terbaru di depan
    for (let i = 0; i < rs.length - 1; i++) {
      const cur = rs[i], prev = rs[i + 1];
      if (cur.pump_on !== prev.pump_on) {
        ev.push(cur.pump_on
          ? { t: cur.created_at, ico: 'drop', tone: 'ok', title: 'Pompa menyala', sub: `Tanah ${cur.soil_moisture}% · mode ${cur.mode}` }
          : { t: cur.created_at, ico: 'stop', tone: 'off', title: 'Pompa mati', sub: `Tanah ${cur.soil_moisture}% · mode ${cur.mode}` });
      }
      if (cur.mode !== prev.mode) {
        ev.push({ t: cur.created_at, ico: 'mode', tone: 'info', title: `Mode berubah ke ${cur.mode}`, sub: 'Dilaporkan oleh ESP32' });
      }
      const hotNow = cur.temperature != null && cur.temperature > CFG.batasSuhu;
      const hotPrev = prev.temperature != null && prev.temperature > CFG.batasSuhu;
      if (hotNow && !hotPrev) ev.push({ t: cur.created_at, ico: 'hot', tone: 'bad', title: 'Suhu tinggi — buzzer berbunyi', sub: `${num(cur.temperature)}°C` });
      if (!hotNow && hotPrev) ev.push({ t: cur.created_at, ico: 'hot', tone: 'warn', title: 'Suhu kembali normal', sub: `${num(cur.temperature)}°C` });
    }
    for (const c of S.commands) {
      ev.push({ t: c.created_at, ico: 'send', tone: 'info', title: `Perintah ${c.command}`, sub: 'Dikirim dari dashboard' });
    }
    return ev.sort((a, b) => ts(b.t) - ts(a.t)).slice(0, 25);
  }

  function renderTimeline() {
    const ev = buildEvents();
    $('timeline').innerHTML = ev.length
      ? ev.map((e) => `<li>
          <span class="tl-ico ${e.tone}">${ICONS[e.ico]}</span>
          <span class="tl-text">${esc(e.title)}<small>${esc(e.sub)}</small></span>
          <time class="tl-time" datetime="${esc(e.t)}" title="${esc(fmtDateTime(e.t))}">${esc(fmtDateTime(e.t))}</time>
        </li>`).join('')
      : '<li class="tl-empty">Belum ada kejadian.</li>';
  }

  // ---------- Riwayat (tabel) ----------
  async function loadHistory({ flashFirst = false } = {}) {
    if (!S.deviceId) return;
    const id = encodeURIComponent(S.deviceId);
    const head = $('history-head');
    const body = $('history-body');
    try {
      if (S.tab === 'readings') {
        const { data, meta } = await api(`/devices/${id}/readings?limit=${PAGE_SIZE}&page=${S.page}`);
        S.total = meta.total;
        head.innerHTML = '<tr><th>Waktu</th><th>Tanah</th><th>Suhu</th><th>Udara</th><th>Pompa</th><th>Mode</th></tr>';
        body.innerHTML = data.length
          ? data.map((r, i) => `<tr class="${flashFirst && i === 0 ? 'is-new' : ''}">
              <td>${esc(fmtDateTime(r.created_at))}</td>
              <td>${r.soil_moisture}%</td>
              <td class="${r.temperature > CFG.batasSuhu ? 'hot' : ''}">${r.temperature == null ? 'error' : num(r.temperature) + '°C'}</td>
              <td>${r.air_humidity == null ? '–' : Math.round(r.air_humidity) + '%'}</td>
              <td><span class="pill ${r.pump_on ? 'pill--on' : 'pill--off'}">${r.pump_on ? 'ON' : 'OFF'}</span></td>
              <td><span class="pill ${r.mode === 'AUTO' ? 'pill--auto' : 'pill--manual'}">${esc(r.mode)}</span></td>
            </tr>`).join('')
          : '<tr><td colspan="6" class="td-empty">Belum ada data sensor.</td></tr>';
      } else {
        const { data } = await api(`/devices/${id}/commands?limit=200`);
        S.total = data.length;
        const rows = data.slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
        head.innerHTML = '<tr><th>#</th><th>Waktu</th><th>Perintah</th><th>Keterangan</th></tr>';
        body.innerHTML = rows.length
          ? rows.map((c) => `<tr>
              <td>${c.id}</td>
              <td>${esc(fmtDateTime(c.created_at))}</td>
              <td><span class="pill ${c.command === 'MODE_AUTO' ? 'pill--auto' : 'pill--manual'}">${esc(c.command)}</span></td>
              <td class="muted">${c.command === 'MODE_AUTO' ? 'Kembali ke mode otomatis' : `Siram manual ${CFG.batasManual} detik`}</td>
            </tr>`).join('')
          : '<tr><td colspan="4" class="td-empty">Belum ada perintah yang dikirim.</td></tr>';
      }
      const pages = Math.max(1, Math.ceil(S.total / PAGE_SIZE));
      const from = S.total ? (S.page - 1) * PAGE_SIZE + 1 : 0;
      const to = Math.min(S.page * PAGE_SIZE, S.total);
      $('pager-info').textContent = `${from}–${to} dari ${S.total.toLocaleString('id-ID')} ${S.tab === 'readings' ? 'data' : 'perintah'}`;
      $('pg-num').textContent = `${S.page} / ${pages}`;
      $('pg-prev').disabled = S.page <= 1;
      $('pg-next').disabled = S.page >= pages;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6" class="td-empty">Gagal memuat: ${esc(e.message)}</td></tr>`;
    }
  }

  let historyTimer = 0;
  function scheduleHistoryRefresh() {
    if (S.tab !== 'readings' || S.page !== 1) return;
    if (historyTimer) return;
    historyTimer = setTimeout(() => { historyTimer = 0; loadHistory({ flashFirst: true }); }, 1500);
  }

  async function exportCsv() {
    const btn = $('btn-export');
    btn.disabled = true;
    try {
      const { data } = await api(`/devices/${encodeURIComponent(S.deviceId)}/readings?limit=1000`);
      const rows = [['waktu', 'kelembapan_tanah', 'suhu', 'kelembapan_udara', 'pompa', 'mode']]
        .concat(data.map((r) => [r.created_at, r.soil_moisture, r.temperature ?? '', r.air_humidity ?? '', r.pump_on ? 'ON' : 'OFF', r.mode]));
      const blob = new Blob(['﻿' + rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `data-sensor-${S.deviceId}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('CSV diunduh', `${data.length} data sensor.`);
    } catch (e) {
      toast('Gagal mengunduh CSV', e.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Realtime (SSE) ----------
  function connectStream() {
    S.es?.close();
    S.streamOk = false;
    if (!S.deviceId || !window.EventSource) return renderStreamChip();
    const es = new EventSource(`${API}/devices/${encodeURIComponent(S.deviceId)}/stream`);
    S.es = es;
    es.onopen = () => { S.streamOk = true; renderStreamChip(); };
    es.onerror = () => { S.streamOk = false; renderStreamChip(); };   // EventSource menyambung ulang otomatis
    es.onmessage = (e) => {
      try { onReading(JSON.parse(e.data)); } catch {}
    };
  }

  function renderStreamChip() {
    // Catatan: lewat Cloudflare, stream baru "terbuka" saat ada data/ping pertama (maks ~25 dtk).
    // Selama itu dashboard tetap update lewat polling tiap 3 detik.
    setChip('chip-stream', S.streamOk ? 'live' : 'ok', S.streamOk ? 'Realtime (SSE)' : 'Auto-refresh 3 dtk');
  }

  function onReading(r) {
    if (r.device_id !== S.deviceId) return;
    if (S.readings.length && r.id <= S.readings[0].id) return;   // duplikat
    S.lastEventAt = Date.now();
    S.readings.unshift(r);
    if (S.readings.length > 1000) S.readings.length = 1000;
    S.latest = r;
    checkConfirmation(r);
    renderLive();
    renderChart();
    renderTimeline();
    scheduleHistoryRefresh();
  }

  // ---------- Pemuatan data ----------
  async function loadHealth() {
    try {
      const { data } = await api('/health');
      S.health = data;
      S.clockOffset = ts(data.time) - Date.now();
      setChip('chip-mqtt', data.mqtt.connected ? 'ok' : 'bad', data.mqtt.connected ? 'MQTT terhubung' : 'MQTT terputus');
      setChip('chip-db', data.database === 'ok' ? 'ok' : 'bad', data.database === 'ok' ? 'Database OK' : 'Database error');
    } catch {
      S.health = false;
      setChip('chip-mqtt', 'bad', 'MQTT ?');
      setChip('chip-db', 'bad', 'Backend offline');
    }
  }

  async function loadDevices() {
    const { data } = await api('/devices');
    S.devices = data;
    const sel = $('device');
    sel.replaceChildren(...data.map((d) => new Option(`${d.name} · ${d.id}`, d.id)));
    $('device-picker').hidden = data.length < 1;
    const saved = store.get('device');
    S.deviceId = data.find((d) => d.id === saved)?.id ?? data[0]?.id ?? null;
    if (S.deviceId) sel.value = S.deviceId;
  }

  async function loadReadings() {
    if (!S.deviceId) return;
    const limit = Math.max(S.range, 150);
    const { data } = await api(`/devices/${encodeURIComponent(S.deviceId)}/readings?limit=${limit}`);
    S.readings = data;
    S.latest = data[0] ?? null;
  }

  async function loadCommands() {
    if (!S.deviceId) return;
    try {
      const { data } = await api(`/devices/${encodeURIComponent(S.deviceId)}/commands?limit=20`);
      S.commands = data;
    } catch {}
  }

  async function loadDevice() {
    S.page = 1;
    S.pending = null;
    setBusy(false);
    setFeedback('idle', 'Siap menerima perintah', 'Perintah dikirim ke ESP32 lewat backend → MQTT.');
    document.body.classList.add('is-loading-data');
    try {
      await Promise.all([loadReadings(), loadCommands()]);
    } catch (e) {
      toast('Gagal memuat data perangkat', e.message, 'bad');
    }
    renderLive();
    renderChart();
    renderTimeline();
    loadStats();
    loadHistory();
    connectStream();
  }

  // ---------- Event UI ----------
  function bindTabs(containerId, attr, onChange) {
    const box = $(containerId);
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[role="tab"]');
      if (!btn) return;
      box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b === btn));
      onChange(btn.dataset[attr]);
    });
  }

  function bindUI() {
    // tampilkan nilai ambang dari config
    document.querySelectorAll('.js-dry').forEach((el) => (el.textContent = CFG.batasKering));
    document.querySelectorAll('.js-manual').forEach((el) => (el.textContent = CFG.batasManual));
    $('lbl-dry').textContent = CFG.batasKering + '%';
    $('lbl-wet').textContent = CFG.batasBasah + '%';
    $('buzzer-sub').textContent = `Bunyi jika suhu > ${CFG.batasSuhu}°C`;
    document.querySelector('.z--dry').style.flex = CFG.batasKering;
    document.querySelector('.z--ok').style.flex = CFG.batasBasah - CFG.batasKering;
    document.querySelector('.z--wet').style.flex = 100 - CFG.batasBasah;
    if (CFG.apiBase) $('docs-link').href = CFG.apiBase.replace(/\/+$/, '') + '/docs.html';
    else if (location.port !== '5173' && !/^(localhost|127\.)/.test(location.hostname)) $('docs-link').href = '/docs.html';

    document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => sendCommand(b.dataset.cmd)));

    $('device').addEventListener('change', (e) => {
      S.deviceId = e.target.value;
      store.set('device', S.deviceId);
      loadDevice();
    });

    $('theme-toggle').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      store.set('theme', root.dataset.theme);
      renderChart();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => renderChart());

    bindTabs('range-tabs', 'range', async (v) => {
      S.range = Number(v);
      if (S.readings.length < S.range) { try { await loadReadings(); } catch {} }
      renderChart();
    });
    bindTabs('stats-tabs', 'hours', (v) => { S.statsHours = Number(v); loadStats(); });
    bindTabs('history-tabs', 'tab', (v) => { S.tab = v; S.page = 1; loadHistory(); });

    $('legend').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ds]');
      if (!b) return;
      const i = Number(b.dataset.ds);
      S.hidden[i] = !S.hidden[i];
      b.setAttribute('aria-pressed', !S.hidden[i]);
      renderChart();
    });
    document.querySelectorAll('#legend [data-ds]').forEach((b) => b.setAttribute('aria-pressed', 'true'));

    $('pg-prev').addEventListener('click', () => { if (S.page > 1) { S.page--; loadHistory(); } });
    $('pg-next').addEventListener('click', () => { S.page++; loadHistory(); });
    $('btn-export').addEventListener('click', exportCsv);
  }

  // ---------- Start ----------
  async function init() {
    bindUI();
    renderStreamChip();
    document.body.classList.add('is-loading-data');
    await loadHealth();
    try {
      await loadDevices();
    } catch (e) {
      renderTick();
      toast('Gagal terhubung ke backend', e.message, 'bad');
      setTimeout(init, 8000);   // coba lagi
      return;
    }
    if (!S.deviceId) {
      $('plant-title').textContent = 'Belum ada perangkat';
      $('plant-desc').textContent = 'Daftarkan perangkat ESP32 di backend terlebih dahulu (POST /api/devices).';
      return;
    }
    await loadDevice();

    setInterval(renderTick, 1000);
    setInterval(() => { loadHealth(); loadStats(); loadCommands().then(renderTimeline); }, 15000);
    // Cadangan jika stream realtime belum/tidak mengirim: ambil data terbaru tiap 3 detik
    setInterval(async () => {
      if (S.streamOk && Date.now() - S.lastEventAt < 6000) return;
      try {
        const { data } = await api(`/devices/${encodeURIComponent(S.deviceId)}/readings?limit=5`);
        data.slice().reverse().forEach(onReading);
      } catch {}
    }, 3000);
    // Saat tab kembali aktif, segarkan semuanya
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadHealth(); loadStats(); } });
  }

  init();
})();
