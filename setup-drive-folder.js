require('dotenv').config();
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.SERVICE_ACCOUNT_KEY,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

async function main() {
  const res = await drive.files.create({
    requestBody: {
      name: 'dreamdb-worksheets',
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  console.log('DRIVE_FOLDER_ID=' + res.data.id);
}

main().catch(console.error);
