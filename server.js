const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// Statik dosyaları public klasöründen sunuyoruz
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Admin
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase bağlandı.');
  }
} catch (error) {
  console.error('❌ Firebase Hatası:', error.message);
}

const db = admin.apps.length ? admin.firestore() : null;
let pendingEmail = null;

async function sendBrevoEmail({ to, subject, htmlContent }) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const SENDER_EMAIL = process.env.SENDER_EMAIL;
  
  const recipients = Array.isArray(to) ? to.map(email => ({ email })) : [{ email: to }];
  
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'ChatixAI', email: SENDER_EMAIL },
    to: recipients,
    subject,
    htmlContent
  }, {
    headers: { 'accept': 'application/json', 'api-key': BREVO_API_KEY, 'content-type': 'application/json' }
  });
}

app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ success: false, message: 'Geçersiz e-posta.' });
    
    if (db) {
      await db.collection('subscribers').doc(email.trim().toLowerCase()).set({
        email: email.trim().toLowerCase(),
        subscribedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    const welcomeHtml = `
      <div style="background-color: #0b0c10; color: #ffffff; padding: 50px 20px; font-family: sans-serif; text-align: center;">
        <div style="max-width: 600px; margin: 0 auto; background: #1f2833; padding: 40px; border-radius: 16px;">
          <h1 style="color: #00f2fe;">ChatixAI</h1>
          <h2>Ekosistemine Hoş Geldin! ✨</h2>
          <p style="color: #c5c6c7;">En yeni model güncellemelerinden ve duyurulardan ilk senin haberin olacak.</p>
          <a href="https://chatixai.onrender.com" style="background: linear-gradient(135deg, #6f42c1, #00f2fe); color: #fff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 20px;">Platformu Keşfet</a>
        </div>
      </div>
    `;
    
    await sendBrevoEmail({ to: email.trim().toLowerCase(), subject: 'ChatixAI Dünyasına Hoş Geldin! ✨', htmlContent: welcomeHtml }).catch(() => {});
    res.status(200).json({ success: true, message: 'Kayıt başarıyla oluşturuldu.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Sunucu hatası.' });
  }
});

app.post('/api/admin/generate-email', async (req, res) => {
  try {
    const { prompt } = req.body;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const systemInstruction = `Sen ChatixAI için e-posta bültenleri oluşturan bir asistansın. Koyu tema (#0b0c10), şık responsive HTML üret. Butonlarda kesinlikle "https://chatixai.onrender.com" kullan. Sadece JSON döndür: {"subject": "...", "htmlContent": "..."}`;

    const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-3.5-flash'];
    let geminiResponse = null;

    for (const model of models) {
      try {
        geminiResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
          contents: [{ role: 'user', parts: [{ text: `${systemInstruction}\n\nMetin:\n${prompt}` }] }],
          generationConfig: { responseMimeType: "application/json" }
        });
        if (geminiResponse?.data) break;
      } catch (e) {}
    }

    if (!geminiResponse) throw new Error('Modeller yoğun, tekrar deneyin.');
    const rawText = geminiResponse.data.candidates[0].content.parts[0].text;
    const parsedData = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());

    pendingEmail = parsedData;
    res.status(200).json({ success: true, data: pendingEmail });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Hata oluştu.' });
  }
});

app.post('/api/admin/send-bulk', async (req, res) => {
  try {
    if (!pendingEmail) return res.status(400).json({ success: false, message: 'Taslak yok.' });
    const snapshot = await db.collection('subscribers').get();
    const emails = [];
    snapshot.forEach(doc => emails.push(doc.id));

    await sendBrevoEmail({ to: emails, subject: pendingEmail.subject, htmlContent: pendingEmail.htmlContent });
    pendingEmail = null;
    res.status(200).json({ success: true, message: `Mailler ${emails.length} kişiye gönderildi!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gönderim hatası.' });
  }
});

// HTML dosyalarını public klasöründen çağırıyoruz
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => console.log(`Çalışıyor: ${PORT}`));
