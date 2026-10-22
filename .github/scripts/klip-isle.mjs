// NE DİYOR?! KLİPLERİ İŞLE (GitHub Actions, .github/workflows/klip-isle.yml)
//
// "Meme Party - Dublaj" aracının "Oyuna gönder" tuşu bir klibi oyunun veritabanına bırakır:
//   onayli/klipgelen/<id>/bilgi  = { paket, paketAd, emoji, ad, dosya, boyut, parca, tip, klip, t, hazir }
//   onayli/klipgelen/<id>/parca/<n> = videonun parçaları (base64)
//   onayli/klipdurum/<id>        = { durum: 'sirada' | 'isleniyor' | 'tamam' | 'hata', mesaj, yol, kb, t } (araç bunu izler)
// Burada: video küçültülür (en çok 1280x720, en çok 30 fps, H.264 CRF 26 + AAC 112k, hızlı başlasın diye faststart),
// klibin kesilen kısmı kesilir (zamanlar kaydırılır), paketler/<paket>/<klip>.mp4 + .json (+ yeni pakete paket.json)
// olarak depoya yazılır, gönderilir ve gelen kutusu boşaltılır. Veritabanına yalnız "izin kağıdı" ile yazılabilir
// (adminkod/<KOD>/izin/<ne>): oyunun kendi yönetici ekranı gibi.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.DB_URL || 'https://meme-party-45451-default-rtdb.europe-west1.firebasedatabase.app';
const KOD = 'MemeAdmin2026';
const NO_PUSH = process.env.NO_PUSH === '1';
/** a half-finished upload older than this is thrown away */
const STALE_MS = 3 * 60 * 60 * 1000;
const MAX_LONG = 1280;
const MAX_SHORT = 720;

const log = (...a) => console.log(...a);

async function req(method, p, body, q = '') {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${DB}/${p}.json${q}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
}
const get = (p, q) => req('GET', p, undefined, q);
const put = (p, v) => req('PUT', p, v);
const del = (p) => req('DELETE', p);

/** a write that only the admin's permission slip lets through */
async function izinle(what, f) {
  const slip = `adminkod/${KOD}/izin/${what}`;
  await put(slip, { '.sv': 'timestamp' });
  try {
    return await f();
  } finally {
    await del(slip).catch(() => undefined);
  }
}

const durumYaz = (id, d) =>
  izinle(`klipdurum_${id}`, () => put(`onayli/klipdurum/${id}`, { ...d, t: { '.sv': 'timestamp' } })).catch((e) =>
    log(`  (durum yazılamadı: ${e.message})`)
  );
const gelenSil = (id) => izinle(`klipgelen_${id}`, () => del(`onayli/klipgelen/${id}`)).catch((e) => log(`  (gelen silinemedi: ${e.message})`));

/** "Film Klasikleri" -> "film-klasikleri" */
function slug(s, fallback) {
  const tr = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
  const out = String(s ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (c) => tr[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return out || fallback;
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).toString();
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round2 = (v) => Math.round(v * 100) / 100;
const even = (v) => Math.max(2, 2 * Math.round(v / 2));

function probe(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  let w = v ? v.width : 0;
  let h = v ? v.height : 0;
  const rot = v ? Math.abs(Number((v.side_data_list || []).find((x) => x.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180 : 0;
  if (rot === 90) [w, h] = [h, w];
  const [fn, fd] = String(v?.avg_frame_rate || v?.r_frame_rate || '30/1').split('/').map(Number);
  const fps = fd ? fn / fd : fn || 30;
  const dur = num(Number(j.format?.duration), num(Number(v?.duration), 0));
  return { v, a, w, h, fps, dur, format: String(j.format?.format_name || '') };
}

/** the video made small (and cut): returns the clip's start and length (seconds of the original) */
function kucult(inFile, outFile, klip) {
  const p = probe(inFile);
  if (!p.v) throw new Error('Videoda görüntü yok');
  if (!(p.dur > 0.3)) throw new Error('Video çok kısa ya da bozuk');
  const c = klip && klip.cut && typeof klip.cut === 'object' ? klip.cut : null;
  let start = c ? Math.max(0, num(c.start, 0)) : 0;
  let end = c ? Math.min(p.dur, num(c.end, p.dur)) : p.dur;
  if (!(end - start >= 0.5)) {
    start = 0;
    end = p.dur;
  }
  const len = end - start;
  const s = Math.min(1, MAX_LONG / Math.max(p.w, p.h), MAX_SHORT / Math.min(p.w, p.h));
  const w = even(p.w * s);
  const h = even(p.h * s);
  const args = ['-y', '-v', 'error'];
  if (start > 0.01) args.push('-ss', start.toFixed(3));
  args.push('-i', inFile, '-t', len.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1');
  args.push('-vf', `scale=${w}:${h}:flags=lanczos,format=yuv420p`);
  if (p.fps > 30.5) args.push('-r', '30');
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-profile:v', 'high', '-level:v', '4.0');
  args.push('-c:a', 'aac', '-b:a', '112k', '-ac', '2', '-ar', '44100', '-movflags', '+faststart', outFile);
  run('ffmpeg', args);
  // already small and not cut: the original (only made to start fast) when that is smaller
  const inSize = fs.statSync(inFile).size;
  const outSize = fs.statSync(outFile).size;
  const plain = !c || (start < 0.01 && end > p.dur - 0.05);
  const okCodecs = p.v.codec_name === 'h264' && (!p.a || p.a.codec_name === 'aac') && /mp4|mov/.test(p.format);
  if (plain && okCodecs && outSize > inSize && Math.max(p.w, p.h) <= MAX_LONG && Math.min(p.w, p.h) <= MAX_SHORT && p.fps <= 30.5) {
    const tmp = `${outFile}.copy.mp4`;
    try {
      run('ffmpeg', ['-y', '-v', 'error', '-i', inFile, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', tmp]);
      if (fs.statSync(tmp).size < outSize) fs.renameSync(tmp, outFile);
    } catch {
      // keep the made-small one
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return { start, len, w, h, inSize, outSize: fs.statSync(outFile).size };
}

/** the dubbing tool's file for the made-small clip: the times of the clip itself, no cut */
function klipJson(klip, videoName, ad, start, len) {
  const k = klip && typeof klip === 'object' ? klip : {};
  const regions = (Array.isArray(k.regions) ? k.regions : [])
    .map((r) => ({ start: num(r?.start, NaN) - start, end: num(r?.end, NaN) - start }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: round2(Math.max(0, Math.min(len, r.start))), end: round2(Math.max(0, Math.min(len, r.end))) }))
    .filter((r) => r.end - r.start >= 0.2)
    .sort((a, b) => a.start - b.start);
  return {
    v: 1,
    video: videoName,
    title: String(k.title || ad || 'Klip').trim().slice(0, 48),
    regions,
    cut: null,
    duration: round2(len),
    beepHz: num(k.beepHz, 520),
    gateDb: typeof k.gateDb === 'number' ? k.gateDb : null,
    micLatency: num(k.micLatency, 0.06),
  };
}

function git(args) {
  return run('git', args).trim();
}

async function main() {
  const ids = Object.keys((await get('onayli/klipgelen', '?shallow=true')) || {});
  if (!ids.length) {
    log('Gelen klip yok.');
    return;
  }
  log(`Gelen: ${ids.join(', ')}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klip-'));
  const done = [];
  for (const id of ids) {
    log(`\n== ${id}`);
    let bilgi;
    try {
      bilgi = await get(`onayli/klipgelen/${id}/bilgi`);
    } catch (e) {
      log(`  okunamadı (sonra tekrar): ${e.message}`);
      continue;
    }
    if (!bilgi) {
      log('  bilgisi yok: atılıyor');
      await gelenSil(id);
      continue;
    }
    const yas = Date.now() - num(bilgi.t, 0);
    if (!bilgi.hazir) {
      if (yas > STALE_MS) {
        log('  yarım kalmış yükleme: atılıyor');
        await durumYaz(id, { durum: 'hata', mesaj: 'Yükleme yarım kaldı, tekrar gönder' });
        await gelenSil(id);
      } else log('  daha yükleniyor: sonraki tura');
      continue;
    }
    try {
      await durumYaz(id, { durum: 'isleniyor' });
      // the pieces
      const n = Math.max(0, Math.floor(num(bilgi.parca, 0)));
      const bufs = [];
      for (let i = 0; i < n; i++) {
        const b64 = await get(`onayli/klipgelen/${id}/parca/${i}`);
        if (typeof b64 !== 'string') throw new Error(`Parça ${i + 1}/${n} eksik`);
        bufs.push(Buffer.from(b64, 'base64'));
      }
      const data = Buffer.concat(bufs);
      if (!data.length) throw new Error('Video boş geldi');
      if (bilgi.boyut && Math.abs(data.length - bilgi.boyut) > 0) throw new Error(`Video eksik geldi (${data.length}/${bilgi.boyut} bayt)`);
      const ext = (String(bilgi.dosya || '').match(/\.([a-z0-9]{2,4})$/i)?.[1] || 'mp4').toLowerCase();
      const inFile = path.join(tmpDir, `${id}-in.${ext}`);
      fs.writeFileSync(inFile, data);

      // where it goes
      // a pack whose name starts with "deneme" stays a test pack: only the TEST copy plays it
      const paket = slug(bilgi.paket || bilgi.paketAd, 'yeni-paket');
      const dir = path.join('paketler', paket);
      fs.mkdirSync(dir, { recursive: true });
      const metaFile = path.join(dir, 'paket.json');
      if (!fs.existsSync(metaFile)) {
        const ad = String(bilgi.paketAd || bilgi.paket || paket).trim().slice(0, 40) || paket;
        fs.writeFileSync(metaFile, JSON.stringify({ ad, emoji: String(bilgi.emoji || '🎬').slice(0, 8), aciklama: '', sira: 50 }, null, 2) + '\n');
      }
      const ad = String(bilgi.ad || bilgi.klip?.title || 'Klip').trim();
      const base = slug(ad, 'klip');
      let name = base;
      for (let k = 2; fs.existsSync(path.join(dir, `${name}.mp4`)) || fs.existsSync(path.join(dir, `${name}.json`)); k++) name = `${base}-${k}`;
      const outFile = path.join(dir, `${name}.mp4`);

      const r = kucult(inFile, outFile, bilgi.klip);
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(klipJson(bilgi.klip, `${name}.mp4`, ad, r.start, r.len), null, 2) + '\n');
      log(`  ${(r.inSize / 1048576).toFixed(2)} MB -> ${(r.outSize / 1048576).toFixed(2)} MB (${r.w}x${r.h}, ${r.len.toFixed(1)} s) => ${dir}/${name}.mp4`);
      git(['add', dir]);
      done.push({ id, yol: `${paket}/${name}`, kb: Math.round(r.outSize / 1024), ad });
    } catch (e) {
      const ham = String(e?.stderr?.toString?.() || e?.message || e).trim();
      const mesaj = /Invalid data|moov atom|could not find codec|Invalid argument/i.test(ham)
        ? 'Video açılamadı (bozuk ya da desteklenmeyen dosya)'
        : ham.split('\n').slice(-2).join(' ').slice(0, 200);
      log(`  HATA: ${mesaj}`);
      await durumYaz(id, { durum: 'hata', mesaj: `İşlenemedi: ${mesaj}` });
      await gelenSil(id);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (!done.length) return;

  git(['config', 'user.name', 'Meme Party Klip Botu']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const msg = done.length === 1 ? `Yeni klip: ${done[0].yol}` : `Yeni klipler: ${done.map((d) => d.yol).join(', ')}`;
  git(['commit', '-m', msg]);
  if (!NO_PUSH) {
    for (let i = 0; ; i++) {
      try {
        git(['push', 'origin', 'HEAD:main']);
        break;
      } catch (e) {
        if (i >= 3) throw e;
        log('  gönderilemedi, güncelleyip tekrar…');
        git(['pull', '--rebase', 'origin', 'main']);
      }
    }
  }
  for (const d of done) {
    await durumYaz(d.id, { durum: 'tamam', yol: d.yol, kb: d.kb });
    await gelenSil(d.id);
  }
  log(`\nBitti: ${done.map((d) => d.yol).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
