// Konfigurasi dashboard.
// apiBase:
//   ''  (kosong) -> pakai server yang sama. Ini default: jalan lewat `npm start` (proxy)
//                   atau kalau folder public/ ini ditaruh di dalam backend.
//   'https://backend-wokwi.kitimaru.my.id' -> panggil backend langsung
//                   (origin dashboard harus terdaftar di CORS_ORIGINS backend).
window.SIRAM_CONFIG = {
  apiBase: '',

  // Ambang batas — samakan dengan konstanta di wokwi/sketch.ino
  batasKering: 30,   // % : di bawah ini pompa menyala (mode AUTO)
  batasBasah: 60,    // % : mulai nilai ini pompa mati (mode AUTO)
  batasSuhu: 35,     // °C: di atas ini buzzer berbunyi
  batasManual: 30,   // detik: lama mode MANUAL sebelum kembali ke AUTO

  // detik tanpa data sebelum ESP32 dianggap offline.
  // Wokwi sering berjalan lebih lambat dari waktu nyata (data tiap 4–8 dtk), jadi beri kelonggaran.
  batasOffline: 25,
};
