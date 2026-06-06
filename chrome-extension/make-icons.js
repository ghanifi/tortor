// make-icons.js — Extension ikonlarını oluşturur (bir kez çalıştır)
// Requires: npm install canvas  (eğer yoksa)
// Veya: node make-icons.js

const fs = require('fs');
const path = require('path');

// Canvas modülü yoksa basit PNG binary oluştur (minimal valid PNG)
function makeSimplePng(size) {
  // Minimal 1x1 PNG'yi size'a scale etmiyoruz, sadece geçerli bir PNG header üretiyoruz
  // Bu gerçek bir icon değil ama Chrome kabul eder
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch (_) { return null; }
  })() || {};

  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Arkaplan
    ctx.fillStyle = '#1a3a6a';
    ctx.fillRect(0, 0, size, size);

    // Yuvarlak köşe efekti
    ctx.fillStyle = '#1e4a8a';
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2 - 2, 0, Math.PI * 2);
    ctx.fill();

    // Robot emoji yerine basit "B" harfi
    ctx.fillStyle = '#7eb3ff';
    ctx.font = `bold ${Math.floor(size * 0.55)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('B', size/2, size/2 + 1);

    return canvas.toBuffer('image/png');
  }

  // canvas modülü yoksa: minimal geçerli PNG (mavi kare)
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000' + size.toString(16).padStart(8,'0') +
    '000000' + size.toString(16).padStart(8,'0') + '08020000000' +
    '0000000' + '0000000c4944415478' +
    '9c6360f8cf000001820080' + '0000ffff' + '030007f8', 'hex'
  );
}

// Daha güvenilir yaklaşım: Base64 encoded minimal PNG'leri gömüyoruz
const ICON_16 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAb0lEQVQ4y2NgGAWkAkZGRsb////TGBgYGBn+M/xHpgEjAwMD438GBgZGBoYBDAwM/xkYGBgZGBj+MzAwMDIwMPxHpv+/GBj+MzA0MDAwMDIwMDL8Z2Bg+M/AwMDIwMDwH5kGjAJSAQAYBgAY9xJOHgAAAABJRU5ErkJggg==', 'base64');

[16, 48, 128].forEach(size => {
  const outPath = path.join(__dirname, 'icons', `icon${size}.png`);
  try {
    const buf = makeSimplePng(size);
    fs.writeFileSync(outPath, buf);
    console.log(`✅ icons/icon${size}.png oluşturuldu`);
  } catch (err) {
    // Fallback: minimal PNG yaz
    fs.writeFileSync(outPath, ICON_16);
    console.log(`✅ icons/icon${size}.png oluşturuldu (fallback)`);
  }
});

console.log('\nİkonlar hazır!');
