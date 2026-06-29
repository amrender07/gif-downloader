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

// ─── CONFIG ────────────────────────────────────────────────────────────────
// Set your Telegram Bot Token here OR in environment variable TELEGRAM_BOT_TOKEN
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8737746224:AAGYzkXhNkYpOiHVgitTzMbcEuvXLN41P1o';
// ───────────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Headers to mimic a real browser visit
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

// POST /api/extract — Tumblr
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'No URL provided.' });

  const tumblrPattern = /^https?:\/\/(www\.)?tumblr\.com\/[^\/]+\/\d+/;
  if (!tumblrPattern.test(url)) {
    return res.status(400).json({ error: 'URL must be a Tumblr post link, e.g. https://www.tumblr.com/blog/123456789' });
  }

  try {
    const response = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000, maxRedirects: 5 });
    const gifs = extractGifUrls(response.data);
    if (gifs.length === 0) return res.status(404).json({ error: 'No GIFs found in this post.' });
    return res.json({ gifs });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Post not found.' });
    if (err.response?.status === 403) return res.status(403).json({ error: 'Blog is private or age-restricted.' });
    return res.status(500).json({ error: 'Failed to fetch the post: ' + err.message });
  }
});

// GET /api/download — Tumblr proxy
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://')) return res.status(400).send('Invalid URL');

  const allowed = /^https:\/\/(64\.media|[a-z0-9]+\.media)\.tumblr\.com\//;
  if (!allowed.test(url)) return res.status(403).send('Only Tumblr CDN URLs are allowed.');

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Referer': 'https://www.tumblr.com/' },
      timeout: 30000,
    });

    let filename = url.split('/').pop().split('?')[0] || 'download.gif';
    if (!filename.toLowerCase().endsWith('.gif')) filename = filename.replace(/\.[^.]+$/, '') + '.gif';

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
  } catch (err) {
    res.status(500).send('Failed to download GIF.');
  }
});

// ════════════════════════════════════════════════════════════
//  TELEGRAM STICKERS
// ════════════════════════════════════════════════════════════

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// POST /api/telegram/stickers — get sticker list from pack
app.post('/api/telegram/stickers', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });

  // Extract pack name from URL: https://t.me/addstickers/PACK_NAME
  const match = url.match(/t\.me\/addstickers\/([a-zA-Z0-9_]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Telegram sticker pack URL. Should look like https://t.me/addstickers/PackName' });

  const packName = match[1];

  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    return res.status(500).json({ error: 'Telegram Bot Token not configured. Add TELEGRAM_BOT_TOKEN to your environment variables.' });
  }

  try {
    const response = await axios.get(`${TG_API}/getStickerSet?name=${packName}`, { timeout: 10000 });
    const { ok, result } = response.data;

    if (!ok || !result) return res.status(404).json({ error: 'Sticker pack not found.' });

    // Filter only animated stickers (video/webm) and static (webp)
    const stickers = result.stickers.map((s, i) => ({
      index: i,
      fileId: s.file_id,
      emoji: s.emoji || '🎭',
      isAnimated: s.is_animated || s.is_video,
      type: s.is_video ? 'video' : s.is_animated ? 'animated' : 'static',
    }));

    return res.json({
      packName: result.name,
      title: result.title,
      stickers,
    });
  } catch (err) {
    if (err.response?.data?.description) {
      return res.status(400).json({ error: err.response.data.description });
    }
    return res.status(500).json({ error: 'Failed to fetch sticker pack: ' + err.message });
  }
});

// GET /api/telegram/download?fileId=...&emoji=...
// Downloads a sticker and converts WebM/WebP → GIF
app.get('/api/telegram/download', async (req, res) => {
  const { fileId, emoji = 'sticker' } = req.query;
  if (!fileId) return res.status(400).send('No fileId provided.');

  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    return res.status(500).send('Bot token not configured.');
  }

  let tmpInput = null;
  let tmpGif = null;

  try {
    // Step 1: Get file path from Telegram
    const fileRes = await axios.get(`${TG_API}/getFile?file_id=${fileId}`, { timeout: 10000 });
    if (!fileRes.data.ok) return res.status(404).send('File not found.');
    const filePath = fileRes.data.result.file_path;

    // Step 2: Download the raw sticker file
    const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const ext = path.extname(filePath) || '.webm';

    tmpInput = path.join(os.tmpdir(), `tg_sticker_${Date.now()}${ext}`);
    tmpGif = path.join(os.tmpdir(), `tg_sticker_${Date.now()}.gif`);

    const fileStream = await axios.get(downloadUrl, { responseType: 'stream', timeout: 30000 });
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpInput);
      fileStream.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    // Step 3: Convert to GIF using ffmpeg
    // WebM animated → GIF with good quality palette
    // WebP static → GIF
    const isWebP = ext === '.webp';

    if (isWebP) {
      // Static sticker: just convert webp → gif
      await execFileAsync('ffmpeg', [
        '-y', '-i', tmpInput,
        tmpGif
      ]);
    } else {
      // Animated WebM → high quality GIF (two-pass with palette)
      const palettePath = path.join(os.tmpdir(), `palette_${Date.now()}.png`);
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-i', tmpInput,
          '-vf', 'fps=15,scale=320:-1:flags=lanczos,palettegen',
          palettePath
        ]);
        await execFileAsync('ffmpeg', [
          '-y', '-i', tmpInput, '-i', palettePath,
          '-filter_complex', 'fps=15,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse',
          tmpGif
        ]);
        fs.unlinkSync(palettePath);
      } catch (e) {
        // Fallback: single-pass conversion
        await execFileAsync('ffmpeg', [
          '-y', '-i', tmpInput,
          '-vf', 'fps=15,scale=320:-1:flags=lanczos',
          tmpGif
        ]);
      }
    }

    // Step 4: Stream GIF back to client
    const filename = `${emoji}_sticker.gif`;
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const gifStream = fs.createReadStream(tmpGif);
    gifStream.pipe(res);
    gifStream.on('end', () => {
      fs.unlink(tmpInput, () => {});
      fs.unlink(tmpGif, () => {});
    });

  } catch (err) {
    console.error('Telegram download error:', err.message);
    if (tmpInput) fs.unlink(tmpInput, () => {});
    if (tmpGif) fs.unlink(tmpGif, () => {});
    res.status(500).send('Failed to convert sticker: ' + err.message);
  }
});

// GET /api/telegram/preview?fileId=... — proxy thumbnail for display
app.get("/api/telegram/preview", async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).send("No fileId");
  try {
    const fileRes = await axios.get(`${TG_API}/getFile?file_id=${fileId}`, { timeout: 10000 });
    if (!fileRes.data.ok) return res.status(404).send("Not found");
    const filePath = fileRes.data.result.file_path;
    const dlUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const upstream = await axios.get(dlUrl, { responseType: "stream", timeout: 20000 });
    res.setHeader("Content-Type", upstream.headers["content-type"] || "image/webp");
    upstream.data.pipe(res);
  } catch (err) {
    res.status(500).send("Preview failed");
  }
});

app.listen(PORT, () => {
  console.log(`GIF Downloader running at http://localhost:${PORT}`);
});