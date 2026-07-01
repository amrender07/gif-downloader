const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ─────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8737746224:AAGYzkXhNkYpOiHVgitTzMbcEuvXLN41P1o';
// ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

// ════════════════════════════════════════════════════════════
//  TUMBLR
// ════════════════════════════════════════════════════════════

function toGifUrl(url) {
  url = url.replace(/\.gifv$/i, '.gif');
  url = url.replace(/_\d+\.jpg$/i, '.gif');
  url = url.split('?')[0];
  return url;
}

function extractGifUrls(html) {
  const gifs = new Set();

  const cdnAll = html.match(/https:\/\/64\.media\.tumblr\.com\/[a-zA-Z0-9_\/.\-?=&%]+(\.gif|\.gifv)[^"'\s<>]*/gi);
  if (cdnAll) cdnAll.forEach(u => gifs.add(toGifUrl(u.split('"')[0].split("'")[0])));

  const mediaAll = html.match(/https:\/\/[a-z0-9]+\.media\.tumblr\.com\/[^"'\s<>]+(\.gif|\.gifv)[^"'\s<>]*/gi);
  if (mediaAll) mediaAll.forEach(u => gifs.add(toGifUrl(u.split('"')[0].split("'")[0])));

  const ogMatch = html.match(/property=["']og:image["'][^>]*content=["']([^"']+\.(gif|gifv)[^"']*)["']/i)
                || html.match(/content=["']([^"']+\.(gif|gifv)[^"']*)["'][^>]*property=["']og:image["']/i);
  if (ogMatch) gifs.add(toGifUrl(ogMatch[1]));

  const jsonBlocks = html.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonBlocks) {
    const urls = block.match(/https:\\\/\\\/64\.media\.tumblr\.com\\\/[^"'\\]+(\.gif|\.gifv)/gi);
    if (urls) urls.forEach(u => gifs.add(toGifUrl(u.replace(/\\\//g, '/'))));
  }

  const escaped = html.match(/https:\\u002F\\u002F64\.media\.tumblr\.com\\u002F[^"'\\]+(\.gif|\.gifv)/gi);
  if (escaped) escaped.forEach(u => gifs.add(toGifUrl(decodeURIComponent(u.replace(/\\u002F/g, '/')))));

  const posters = html.match(/https:\/\/64\.media\.tumblr\.com\/[^"'\s<>]+_frame1\.jpg/gi);
  if (posters) posters.forEach(u => gifs.add(toGifUrl(u.split('"')[0].split("'")[0])));

  return [...gifs].filter(u => u.startsWith('http') && u.endsWith('.gif'));
}

function extractVideoUrls(html) {
  const videos = new Set();

  // Strategy 1: direct .mp4 on Tumblr CDN
  const cdnMp4 = html.match(/https:\/\/[a-z0-9]+\.tumblr\.com\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
  if (cdnMp4) cdnMp4.forEach(u => videos.add(u.split('"')[0].split("'")[0].split('\\')[0]));

  // Strategy 2: va.media.tumblr.com (video CDN)
  const vaMp4 = html.match(/https:\/\/va\.media\.tumblr\.com\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
  if (vaMp4) vaMp4.forEach(u => videos.add(u.split('"')[0].split("'")[0]));

  // Strategy 3: video src attributes
  const srcMp4 = html.match(/src=["'](https:\/\/[^"'\s<>]+\.mp4[^"']*)/gi);
  if (srcMp4) srcMp4.forEach(u => {
    const m = u.match(/src=["'](https:\/\/[^"'\s<>]+\.mp4[^"']*)/i);
    if (m) videos.add(m[1].split('?')[0]);
  });

  // Strategy 4: JSON blocks with escaped mp4 URLs
  const jsonBlocks = html.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonBlocks) {
    const urls = block.match(/https:\\\/\\\/[^"'\\]+\.mp4/gi);
    if (urls) urls.forEach(u => videos.add(u.replace(/\\\//g, '/').split('"')[0]));
  }

  // Strategy 5: og:video meta tag
  const ogVideo = html.match(/property=["']og:video["'][^>]*content=["']([^"']+\.mp4[^"']*)["']/i)
                || html.match(/content=["']([^"']+\.mp4[^"']*)["'][^>]*property=["']og:video["']/i);
  if (ogVideo) videos.add(ogVideo[1].split('?')[0]);

  // Strategy 6: iframely / embed URLs with mp4
  const iframeMp4 = html.match(/["'](https:\/\/[^"'\s]+tumblr[^"'\s]+\.mp4)[^"'\s]*/gi);
  if (iframeMp4) iframeMp4.forEach(u => {
    const clean = u.replace(/^["']/, '').split(/["'\s]/)[0].split('?')[0];
    if (clean.endsWith('.mp4')) videos.add(clean);
  });

  return [...videos].filter(u => u.startsWith('http') && u.includes('.mp4'));
}

// POST /api/extract — Tumblr (GIFs + Videos)
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'No URL provided.' });

  const tumblrPattern = /^https?:\/\/(www\.)?tumblr\.com\/[^\/]+\/\d+/;
  if (!tumblrPattern.test(url)) {
    return res.status(400).json({ error: 'URL must be a Tumblr post link, e.g. https://www.tumblr.com/blog/123456789' });
  }

  try {
    const response = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000, maxRedirects: 5 });
    const html = response.data;
    const gifs = extractGifUrls(html);
    const videos = extractVideoUrls(html);

    if (gifs.length === 0 && videos.length === 0) {
      return res.status(404).json({ error: 'No GIFs or videos found in this post.' });
    }
    return res.json({ gifs, videos });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Post not found.' });
    if (err.response?.status === 403) return res.status(403).json({ error: 'Blog is private or age-restricted.' });
    return res.status(500).json({ error: 'Failed to fetch the post: ' + err.message });
  }
});

// GET /api/download — proxy GIF or video from Tumblr CDN
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://')) return res.status(400).send('Invalid URL');

  const allowed = /^https:\/\/([a-z0-9]+\.)?(media|tumblr|va\.media)\.tumblr\.com\//;
  if (!allowed.test(url)) return res.status(403).send('Only Tumblr CDN URLs are allowed.');

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Referer': 'https://www.tumblr.com/' },
      timeout: 60000,
    });

    const isVideo = url.includes('.mp4');
    let filename = url.split('/').pop().split('?')[0] || (isVideo ? 'video.mp4' : 'download.gif');
    if (!isVideo && !filename.toLowerCase().endsWith('.gif')) {
      filename = filename.replace(/\.[^.]+$/, '') + '.gif';
    }

    res.setHeader('Content-Type', isVideo ? 'video/mp4' : 'image/gif');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
  } catch (err) {
    res.status(500).send('Failed to download file.');
  }
});

// ════════════════════════════════════════════════════════════
//  TELEGRAM STICKERS
// ════════════════════════════════════════════════════════════

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function downloadTgFile(fileId) {
  const fileRes = await axios.get(`${TG_API}/getFile?file_id=${fileId}`, { timeout: 10000 });
  if (!fileRes.data.ok) throw new Error('File not found on Telegram');
  const filePath = fileRes.data.result.file_path;
  const ext = path.extname(filePath) || '.webm';
  const dlUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const tmpPath = path.join(os.tmpdir(), `tg_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  const stream = await axios.get(dlUrl, { responseType: 'stream', timeout: 30000 });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmpPath);
    stream.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return { tmpPath, ext };
}

async function convertToGif(tmpInput, ext) {
  const tmpGif = path.join(os.tmpdir(), `tg_gif_${Date.now()}.gif`);
  const isWebP = ext === '.webp';
  if (isWebP) {
    await execFileAsync('ffmpeg', ['-y', '-i', tmpInput, tmpGif]);
  } else {
    const palettePath = path.join(os.tmpdir(), `palette_${Date.now()}.png`);
    try {
      await execFileAsync('ffmpeg', ['-y', '-i', tmpInput, '-vf', 'fps=15,scale=320:-1:flags=lanczos,palettegen', palettePath]);
      await execFileAsync('ffmpeg', ['-y', '-i', tmpInput, '-i', palettePath, '-filter_complex', 'fps=15,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse', tmpGif]);
      fs.unlink(palettePath, () => {});
    } catch {
      await execFileAsync('ffmpeg', ['-y', '-i', tmpInput, '-vf', 'fps=15,scale=320:-1:flags=lanczos', tmpGif]);
    }
  }
  return tmpGif;
}

async function convertToPng(tmpInput) {
  const tmpPng = path.join(os.tmpdir(), `tg_preview_${Date.now()}.png`);
  await execFileAsync('ffmpeg', ['-y', '-i', tmpInput, '-vframes', '1', '-vf', 'scale=200:-1', tmpPng]);
  return tmpPng;
}

app.post('/api/telegram/stickers', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });

  const match = url.match(/t\.me\/addstickers\/([a-zA-Z0-9_]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Telegram sticker pack URL.' });

  const packName = match[1];
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    return res.status(500).json({ error: 'Telegram Bot Token not configured.' });
  }

  try {
    const response = await axios.get(`${TG_API}/getStickerSet?name=${packName}`, { timeout: 10000 });
    const { ok, result } = response.data;
    if (!ok || !result) return res.status(404).json({ error: 'Sticker pack not found.' });

    const stickers = result.stickers.map((s, i) => ({
      index: i,
      fileId: s.file_id,
      thumbFileId: s.thumbnail?.file_id || s.file_id,
      emoji: s.emoji || 'sticker',
      isAnimated: s.is_animated || s.is_video,
      type: s.is_video ? 'video' : s.is_animated ? 'animated' : 'static',
    }));

    return res.json({ packName: result.name, title: result.title, stickers });
  } catch (err) {
    if (err.response?.data?.description) return res.status(400).json({ error: err.response.data.description });
    return res.status(500).json({ error: 'Failed to fetch sticker pack: ' + err.message });
  }
});

app.get('/api/telegram/preview', async (req, res) => {
  const { fileId, animated } = req.query;
  if (!fileId) return res.status(400).send('No fileId');

  let tmpPath = null;
  let tmpOut = null;

  try {
    const { tmpPath: dl, ext } = await downloadTgFile(fileId);
    tmpPath = dl;

    if (animated === 'true') {
      tmpOut = await convertToPng(tmpPath);
      res.setHeader('Content-Type', 'image/png');
      const s = fs.createReadStream(tmpOut);
      s.pipe(res);
      s.on('end', () => { fs.unlink(tmpPath, () => {}); fs.unlink(tmpOut, () => {}); });
    } else {
      res.setHeader('Content-Type', 'image/webp');
      const s = fs.createReadStream(tmpPath);
      s.pipe(res);
      s.on('end', () => fs.unlink(tmpPath, () => {}));
    }
  } catch (err) {
    console.error('Preview error:', err.message);
    if (tmpPath) fs.unlink(tmpPath, () => {});
    if (tmpOut) fs.unlink(tmpOut, () => {});
    res.status(500).send('Preview failed');
  }
});

app.get('/api/telegram/download', async (req, res) => {
  const { fileId, index = '0' } = req.query;
  if (!fileId) return res.status(400).send('No fileId provided.');
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') return res.status(500).send('Bot token not configured.');

  let tmpInput = null;
  let tmpGif = null;

  try {
    const { tmpPath, ext } = await downloadTgFile(fileId);
    tmpInput = tmpPath;
    tmpGif = await convertToGif(tmpInput, ext);

    const filename = `sticker_${String(index).padStart(3, '0')}.gif`;
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const gifStream = fs.createReadStream(tmpGif);
    gifStream.pipe(res);
    gifStream.on('end', () => { fs.unlink(tmpInput, () => {}); fs.unlink(tmpGif, () => {}); });
  } catch (err) {
    console.error('Telegram download error:', err.message);
    if (tmpInput) fs.unlink(tmpInput, () => {});
    if (tmpGif) fs.unlink(tmpGif, () => {});
    res.status(500).send('Failed to convert sticker: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`GIF Downloader running at http://localhost:${PORT}`);
});