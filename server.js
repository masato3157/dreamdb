require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const multer = require('multer');
const { Readable } = require('stream');

const REQUIRED_ENV = ['SPREADSHEET_ID', 'GEMINI_API_KEY', 'GCS_BUCKET_NAME', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'SERVICE_ACCOUNT_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3460;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim());

// Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Service account for Sheets + Drive (read fallback) + GCS
const serviceAuth = new google.auth.GoogleAuth({
  keyFile: process.env.SERVICE_ACCOUNT_KEY,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
});
const sheets = google.sheets({ version: 'v4', auth: serviceAuth });
const drive = google.drive({ version: 'v3', auth: serviceAuth });
const gcs = new Storage({ keyFilename: process.env.SERVICE_ACCOUNT_KEY });

let _cachedSheetId = null;
async function getSheetId() {
  if (_cachedSheetId !== null) return _cachedSheetId;
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = res.data.sheets.find(s => s.properties.title === 'シート1');
  _cachedSheetId = sheet ? sheet.properties.sheetId : 0;
  return _cachedSheetId;
}

// Upload to GCS (service account, no quota issues)
async function uploadToGCS(buffer, mimeType, filename) {
  const bucket = gcs.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(filename);
  await file.save(buffer, { metadata: { contentType: mimeType } });
  return filename;
}

// Middleware
app.set('trust proxy', 1);
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// --- Auth routes ---
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(userInfo.email)) {
      return res.send('<h1>アクセス権限がありません</h1><p>管理者にお問い合わせください。</p>');
    }

    req.session.user = { email: userInfo.email, name: userInfo.name };
    res.redirect('/');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// --- Sheets API routes ---

// Get all records
app.get('/api/records', requireAuth, async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'シート1!A1:Z',
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ headers: rows[0] || [], records: [] });

    const headers = rows[0];
    const records = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    res.json({ headers, records });
  } catch (err) {
    console.error('Sheets read error:', err.message);
    res.status(500).json({ error: 'スプレッドシートの読み取りに失敗しました' });
  }
});

// Get next ID
async function getNextId() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'シート1!A:A',
  });
  const rows = response.data.values || [];
  const lastRow = rows[rows.length - 1];
  if (!lastRow || !lastRow[0] || lastRow[0] === 'ID') return 'DW-0001';
  const lastNum = parseInt(lastRow[0].replace('DW-', ''), 10);
  return `DW-${String(lastNum + 1).padStart(4, '0')}`;
}

// Create record
app.post('/api/records', requireAuth, async (req, res) => {
  try {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const id = await getNextId();
    const d = req.body;

    const row = [
      id, req.session.user.email, now, '', now, d.入力元 || 'フォーム入力',
      d.夢主年代 || '', d.夢主性別 || '', d.夢主の状況 || '',
      d['ワーク前に自覚していた悩み'] || '', d['ワーク後に自覚した悩み'] || '',
      d.夢の分類 || '', d.夢の内容 || '',
      d.ワーク中の気づき || '', d.後日談 || '', d.大高メモ || '',
      d.公開可否 || '要確認',
      '', '',  // 教材化テーマ, テーマタグ
      '', '', '',  // SNS化しやすさ, 講座化しやすさ, 埋込ベクトル
      d.画像ID || '',  // 画像ID (Google Drive, comma-separated)
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'シート1!A1',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    res.json({ ok: true, id });
  } catch (err) {
    console.error('Sheets write error:', err.message);
    res.status(500).json({ error: '保存に失敗しました: ' + err.message });
  }
});

// Update record
app.put('/api/records/:id', requireAuth, async (req, res) => {
  try {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const { id } = req.params;

    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'シート1!A:A',
    });
    const rows = readRes.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === id);
    if (rowIdx < 1) return res.status(404).json({ error: 'レコードが見つかりません' });

    const sheetRow = rowIdx + 1;
    const d = req.body;

    const existRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `シート1!A${sheetRow}:Z${sheetRow}`,
    });
    const existing = existRes.data.values?.[0] || [];

    const row = [
      existing[0] || id,
      existing[1] || '',
      existing[2] || '',
      req.session.user.email,
      now,
      d.入力元 || existing[5] || 'フォーム入力',
      d.夢主年代 || '', d.夢主性別 || '', d.夢主の状況 || '',
      d['ワーク前に自覚していた悩み'] || '', d['ワーク後に自覚した悩み'] || '',
      d.夢の分類 || '', d.夢の内容 || '',
      d.ワーク中の気づき || '', d.後日談 || '', d.大高メモ || '',
      d.公開可否 || '要確認',
      d.教材化テーマ || '', d.テーマタグ || '',
      existing[19] || '', existing[20] || '', existing[21] || '',
      existing[22] || '',  // 画像ID は更新時も既存値を保持
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `シート1!A${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Sheets update error:', err.message);
    res.status(500).json({ error: '更新に失敗しました: ' + err.message });
  }
});

// Delete record
app.delete('/api/records/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'シート1!A:A',
    });
    const rows = readRes.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === id);
    if (rowIdx < 1) return res.status(404).json({ error: 'レコードが見つかりません' });

    const imgRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `シート1!W${rowIdx + 1}`,
    });
    const imageId = imgRes.data.values?.[0]?.[0] || '';

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: await getSheetId(),
              dimension: 'ROWS',
              startIndex: rowIdx,
              endIndex: rowIdx + 1,
            },
          },
        }],
      },
    });

    if (imageId) {
      const fileIds = imageId.split(',').map(s => s.trim()).filter(Boolean);
      await Promise.allSettled(fileIds.map(async fileId => {
        try {
          const file = gcs.bucket(GCS_BUCKET_NAME).file(fileId);
          await file.delete({ ignoreNotFound: true });
        } catch (e) {
          console.error('GCS delete error:', fileId, e.message);
        }
      }));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).json({ error: '削除に失敗しました: ' + err.message });
  }
});

// Initialize sheet headers
app.post('/api/init-sheet', requireAuth, async (req, res) => {
  const headers = [
    'ID', '入力者', '入力日時', '最終更新者', '最終更新日時', '入力元',
    '夢主年代', '夢主性別', '夢主の状況', 'ワーク前に自覚していた悩み', 'ワーク後に自覚した悩み',
    '夢の分類', '夢の内容',
    'ワーク中の気づき', '後日談', '大高メモ',
    '公開可否', '教材化テーマ', 'テーマタグ',
    'SNS化しやすさ', '講座化しやすさ', '埋込ベクトル', '画像ID'
  ];
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'シート1!A1',
      valueInputOption: 'RAW',
      resource: { values: [headers] },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OCR: 画像(base64+JSON) → Gemini OCR → GCS保存 → 構造化データ
app.post('/api/ocr', requireAuth, async (req, res) => {
  try {
    const images = req.body.images;
    if (!images || images.length === 0) {
      return res.status(400).json({ error: '画像が選択されていません' });
    }

    // 1. Gemini OCR（先に実行。失敗した場合はGCSアップロードしない）
    const parts = images.map(img => ({
      inline_data: {
        mime_type: img.type || 'image/jpeg',
        data: img.data,
      },
    }));
    parts.push({
      text: `このワークシート画像を読み取り、手書きテキストを抽出してください。
印刷された項目ラベルと手書き内容の両方を読んでください。
赤ペンや青ペンなど色の異なる書き込みもすべて読んでください。
読み取れない箇所は空欄のままにしてください。

必ずJSONのみを返してください（説明文・コードブロック不要）:
{
  "夢の内容": "ワークシートに記入された夢の本文",
  "ワーク中の気づき": "ワーク中に気づいたこと",
  "後日談": "後日談・その後の変化（なければ空文字）",
  "大高メモ": "大高先生の書き込み・赤ペンコメント（なければ空文字）",
  "夢の分類": "悪夢/繰り返し夢/断片/色のみ/音のみ/その他（記載なければ空文字）"
}`,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error('Gemini APIエラー: ' + geminiRes.status + ' ' + errText);
    }

    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('OCR結果の解析に失敗しました');
    const ocrResult = JSON.parse(jsonMatch[0]);

    // 2. OCR成功後にGCSアップロード（孤立ファイルを防止）
    const tempId = `tmp-${Date.now()}`;
    const fileIds = await Promise.all(images.map((img, i) => {
      const mimeType = img.type || 'image/jpeg';
      const ext = mimeType.split('/')[1] || 'jpg';
      const buffer = Buffer.from(img.data, 'base64');
      return uploadToGCS(buffer, mimeType, `${tempId}_${i + 1}.${ext}`);
    }));

    res.json({ ok: true, data: ocrResult, fileIds });
  } catch (err) {
    console.error('OCR error:', err.message);
    res.status(500).json({ error: 'OCR処理エラー: ' + err.message });
  }
});

// テキスト分析: 自由文 → 全フィールド構造化
app.post('/api/analyze-text', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'テキストが入力されていません' });
    }

    const prompt = `あなたは夢分析の専門家・大高ゆうこのアシスタントです。
以下のテキストは、夢ワークセッションの記録です。内容を読み取り、各フィールドに当てはまる情報を抽出してください。

テキスト:
"""
${text}
"""

必ずJSONのみを返してください（説明文・コードブロック不要）。情報がない項目は空文字にしてください:
{
  "夢主年代": "10代/20代/30代/40代/50代/60代以上 のいずれか。記載がなければ空文字",
  "夢主性別": "男性/女性/その他 のいずれか。記載がなければ空文字",
  "夢主の状況": "夢を見た人の当時の状況・背景",
  "ワーク前に自覚していた悩み": "ワーク前に本人が自覚していた悩み・問題",
  "ワーク後に自覚した悩み": "ワーク後に新たに気づいた悩み・問題",
  "夢の分類": "悪夢/繰り返し夢/断片/色のみ/音のみ/臭いのみ/味覚のみ/触感のみ/感情のみ/その他 のいずれか。記載がなければ空文字",
  "夢の内容": "夢の本文・ストーリー",
  "ワーク中の気づき": "ワーク中に得られた気づき・洞察",
  "後日談": "その後の変化・後日談",
  "大高メモ": "特記事項・大高先生のメモ"
}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error('Gemini APIエラー: ' + geminiRes.status + ' ' + errText);
    }

    const geminiData = await geminiRes.json();
    const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI分析結果の解析に失敗しました');
    const result = JSON.parse(jsonMatch[0]);

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('analyze-text error:', err.message);
    res.status(500).json({ error: 'AI分析エラー: ' + err.message });
  }
});

// 画像配信（認証必須）: GCS優先、旧DriveファイルはDriveフォールバック
app.get('/api/images/:fileId', requireAuth, async (req, res) => {
  const { fileId } = req.params;

  // GCSから取得（新規ファイル）
  try {
    const bucket = gcs.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(fileId);
    const [exists] = await file.exists();
    if (exists) {
      const [metadata] = await file.getMetadata();
      res.setHeader('Content-Type', metadata.contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      file.createReadStream()
        .on('error', err => {
          console.error('GCS stream error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: '画像の読み込みに失敗しました' });
          else res.destroy();
        })
        .pipe(res);
      return;
    }
  } catch (e) {
    console.warn('GCS fetch failed, falling back to Drive:', e.message);
    // fall through to Drive
  }

  // Driveフォールバック（旧ファイル対応）
  try {
    const driveRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', driveRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    driveRes.data.pipe(res);
  } catch (err) {
    console.error('Image fetch error:', err.message);
    res.status(404).json({ error: '画像が見つかりません' });
  }
});

// Global error handler — ensures JSON errors instead of HTML pages
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`DreamDB server running on http://localhost:${PORT}`);
});
