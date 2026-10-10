const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Firebase Admin Initialization
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK başarıyla bağlandı.');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT çevresel değişkeni bulunamadı!');
  }
} catch (error) {
  console.error('❌ Firebase Başlatma Hatası:', error.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// Geçici Taslak E-Posta Hafızası (In-Memory Pending Mail)
let pendingEmail = null;

// Helper: Brevo HTTP API üzerinden Mail Gönderimi
async function sendBrevoEmail({ to, subject, htmlContent }) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const SENDER_EMAIL = process.env.SENDER_EMAIL;

  if (!BREVO_API_KEY || !SENDER_EMAIL) {
    throw new Error('Brevo API anahtarı veya gönderici e-posta adresi eksik.');
  }

  const recipients = Array.isArray(to) 
    ? to.map(email => ({ email })) 
    : [{ email: to }];

  const payload = {
    sender: { name: 'ChatixAI', email: SENDER_EMAIL },
    to: recipients,
    subject: subject,
    htmlContent: htmlContent
  };

  const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
    headers: {
      'accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json'
    }
  });

  return response.data;
}

// ------------------- API ENDPOINT'LERİ -------------------

// 1. POST /api/subscribe (Kullanıcı Abonelik Kaydı)
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Lütfen geçerli bir e-posta adresi girin.' });
    }

    if (!db) {
      return res.status(500).json({ success: false, message: 'Veritabanı bağlantısı henüz hazır değil.' });
    }

    const subscriberRef = db.collection('subscribers').doc(email.trim().toLowerCase());
    await subscriberRef.set({
      email: email.trim().toLowerCase(),
      subscribedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Hoş Geldin E-Postası Şablonu (Banner Yok, Minimalist)
    const welcomeHtml = `
      <div style="background-color: #0b0c10; color: #ffffff; padding: 40px 20px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center;">
        <div style="max-width: 600px; margin: 0 auto; background: #1f2833; padding: 30px; border-radius: 12px; border: 1px solid #333;">
          <h1 style="color: #00f2fe; margin-bottom: 10px;">ChatixAI</h1>
          <h2 style="color: #ffffff; font-size: 20px;">Dünyasına Hoş Geldin! ✨</h2>
          <p style="color: #c5c6c7; line-height: 1.6; font-size: 15px; margin-top: 20px;">
            Aramıza katıldığın için heyecanlıyız! En yeni model güncellemelerimizden, yapay zeka ipuçlarından ve özel duyurulardan ilk senin haberin olacak.
          </p>
          <div style="margin-top: 30px;">
            <a href="https://chatix.ai" style="background: linear-gradient(135deg, #6f42c1, #00f2fe); color: #fff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">Platformu Keşfet</a>
          </div>
          <hr style="border: 0; border-top: 1px solid #333; margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">© 2026 ChatixAI. Tüm hakları saklıdır.</p>
        </div>
      </div>
    `;

    try {
      await sendBrevoEmail({
        to: email.trim().toLowerCase(),
        subject: 'ChatixAI Dünyasına Hoş Geldin! ✨',
        htmlContent: welcomeHtml
      });
    } catch (mailError) {
      console.error('Hoş geldin maili gönderilemedi:', mailError.message);
    }

    return res.status(200).json({ success: true, message: 'Harika! Kaydınız başarıyla oluşturuldu.' });

  } catch (error) {
    console.error('Abonelik hatası:', error);
    return res.status(500).json({ success: false, message: 'Sunucu hatası oluştu. Lütfen tekrar deneyin.' });
  }
});

// 2. POST /api/admin/generate-email (Gemini 3.5 Flash ile E-Posta Oluşturma)
app.post('/api/admin/generate-email', async (req, res) => {
  try {
    const { prompt } = req.body;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!prompt) {
      return res.status(400).json({ success: false, message: 'Lütfen bir duyuru metni girin.' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'GEMINI_API_KEY çevresel değişkeni tanımlanmamış.' });
    }

    const systemInstruction = `
Sen ChatixAI için e-posta bültenleri oluşturan profesyonel bir yapay zeka asistanısın. 
Görevin, sana verilen metinden yola çıkarak son derece şık, koyu temalı (#0b0c10 arka plan, #1f2833 kartlar, #00f2fe ve #6f42c1 vurgu renkleri), responsive, banner içermeyen (sadece metin ve buton odaklı) ve tüm e-posta istemcileriyle uyumlu inline CSS barındıran HTML bir e-posta taslağı ve bir konu başlığı oluşturmaktır.

ÇIKTI FORMATI ZORUNLULUĞU:
Yalnızca ve yalnızca aşağıdaki JSON formatında yanıt ver. Markdown kod blokları (\`\`\`json vb.), hiçbir ek açıklama veya ön metin EKLEME.

{
  "subject": "E-posta Konu Başlığı (Emoji içerebilir)",
  "htmlContent": "<div style=\\"...\\">Tüm HTML Kodları Inline CSS Ile Burada</div>"
}
    `;

    // Güncel Gemini 3.5 Flash Modeli
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const geminiResponse = await axios.post(geminiUrl, {
      contents: [
        {
          role: 'user',
          parts: [
            { text: `${systemInstruction}\n\nKullanıcının Duyuru Metni:\n${prompt}` }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const rawText = geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('Gemini API geçerli bir yanıt üretmedi.');
    }

    const cleanJsonText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(cleanJsonText);

    if (!parsedData.subject || !parsedData.htmlContent) {
      throw new Error('Üretilen içerik beklenen JSON yapısına uymuyor.');
    }

    pendingEmail = {
      subject: parsedData.subject,
      htmlContent: parsedData.htmlContent,
      createdAt: new Date()
    };

    return res.status(200).json({
      success: true,
      data: pendingEmail
    });

  } catch (error) {
    console.error('E-posta üretme hatası:', error?.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Yapay zeka e-posta taslağını oluştururken bir hata oluştu.' });
  }
});

// 3. POST /api/admin/send-bulk (Toplu E-Posta Gönderimi)
app.post('/api/admin/send-bulk', async (req, res) => {
  try {
    if (!pendingEmail) {
      return res.status(400).json({ success: false, message: 'Gönderilecek onaylanmış bir e-posta taslağı bulunamadı. Önce bir taslak oluşturun.' });
    }

    if (!db) {
      return res.status(500).json({ success: false, message: 'Veritabanı bağlantısı yok.' });
    }

    const snapshot = await db.collection('subscribers').get();
    if (snapshot.empty) {
      return res.status(404).json({ success: false, message: 'Sistemde kayıtlı hiçbir abone bulunamadı.' });
    }

    const subscriberEmails = [];
    snapshot.forEach(doc => {
      if (doc.exists && doc.id) {
        subscriberEmails.push(doc.id);
      }
    });

    await sendBrevoEmail({
      to: subscriberEmails,
      subject: pendingEmail.subject,
      htmlContent: pendingEmail.htmlContent
    });

    const sentCount = subscriberEmails.length;
    pendingEmail = null;

    return res.status(200).json({
      success: true,
      message: `Toplu e-posta başarıyla ${sentCount} aboneye gönderildi!`,
      count: sentCount
    });

  } catch (error) {
    console.error('Toplu gönderim hatası:', error?.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Toplu e-posta gönderilirken bir hata oluştu.' });
  }
});

// Statik Rotalar
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Sunucuyu Dinle
app.listen(PORT, () => {
  console.log(`🚀 ChatixAI sunucusu ${PORT} portunda yayında.`);
});
