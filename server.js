require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const multer = require('multer');
const { Readable } = require('stream');

const REQUIRED_ENV = ['SPREADSHEET_ID', 'GEMINI_API_KEY', 'DRIVE_FOLDER_ID', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'SERVICE_ACCOUNT_KEY'];
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
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim());

// Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Service account for Sheets + Drive API
const serviceAuth = new google.auth.GoogleAuth({
  keyFile: process.env.SERVICE_ACCOUNT_KEY,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ],
});
const sheets = google.sheets({ version: 'v4', auth: serviceAuth });
const drive = google.drive({ version: 'v3', auth: serviceAuth });

// Middleware
app.set('trust proxy', 1);
app.use(express.json());
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

// Drive upload helper
async function uploadToDrive(buffer, mimeType, filename) {
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id',
  });
  return res.data.id;
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
      id, '', now, '', now, d.入力元 || 'フォーム入力',
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

// OCR: 画像 → Drive保存 + Gemini OCR → 構造化データ
app.post('/api/ocr', requireAuth, (req, res, next) => {
  upload.array('images', 3)(req, res, err => {
    if (err) return res.status(400).json({ error: 'ファイルエラー: ' + err.message });
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '画像が選択されていません' });
    }

    // Drive upload と Gemini OCR を並行実行
    const tempId = `tmp-${Date.now()}`;

    const [fileIds, ocrResult] = await Promise.all([
      // Google Drive に保存
      Promise.all(files.map((file, i) => {
        const ext = file.mimetype.split('/')[1] || 'jpg';
        return uploadToDrive(file.buffer, file.mimetype, `${tempId}_${i + 1}.${ext}`);
      })),
      // Gemini OCR
      (async () => {
        const parts = files.map(file => ({
          inline_data: {
            mime_type: file.mimetype,
            data: file.buffer.toString('base64'),
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
        const response = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }] }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          throw new Error('Gemini APIエラー: ' + response.status + ' ' + errText);
        }

        const geminiData = await response.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('OCR結果の解析に失敗しました');
        return JSON.parse(jsonMatch[0]);
      })(),
    ]);

    res.json({ ok: true, data: ocrResult, fileIds });
  } catch (err) {
    console.error('OCR error:', err.message);
    res.status(500).json({ error: 'OCR処理エラー: ' + err.message });
  }
});

// Drive画像配信（認証必須）
app.get('/api/images/:fileId', requireAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    const driveRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', driveRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    driveRes.data.pipe(res);
  } catch (err) {
    console.error('Drive fetch error:', err.message);
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
