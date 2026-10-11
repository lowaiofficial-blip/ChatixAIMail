const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statik dosyalar için public klasörünü aktif et (index.html ve admin.html buradan okunur)
app.use(express.static(path.join(__dirname, 'public')));

// 1. Firebase Başlatma (Render Environment Variables / JSON içeriğiyle)
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (err) {
        console.error("Firebase başlatma hatası:", err.message);
    }
}
const db = admin.firestore();

// 2. Brevo SMTP Konfigürasyonu
const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_PASS
    }
});

// 3. AI System Instruction - ChatGPT Bülten Tarzı, Logo ve Mail Bağlantısı Entegre Edilmiş Hali
const systemInstruction = `
Sen ChatixAI için e-posta bültenleri oluşturan profesyonel bir yapay zeka asistanısın. 
Görevin, sana verilen metinden yola çıkarak OpenAI (ChatGPT) bülten tarzına benzer; son derece şık, koyu temalı (#0b0c10 arka plan, #1f2833 footer, beyaz metinler, #00f2fe vurgu renkleri), responsive, üst kısımda "Chatix" (beyaz) ve "AI" (turkuaz #00f2fe) logosu barındıran, ortada büyük dikkat çekici başlıklar ve net paragraflar içeren, ana yönlendirme butonları "https://chatixai.onrender.com" adresine giderken, en alt footer alanında telif yılı 2026 ve yanında küçük mavi bir link şeklinde "Abone ol" (tıklandığında doğrudan mail uygulamasını açıp "chatixai.business@outlook.com" adresine abone olma talebi maili hazırlayan \`mailto:chatixai.business@outlook.com?subject=Abone%20Olmak%20İstiyorum\` bağlantısı olan) metni barındıran inline CSS'li HTML bir e-posta taslağı oluşturmaktır.

ÖNEMLİ KURALLAR:
1. Ana buton ve yönlendirme linkleri için kesinlikle "https://chatixai.onrender.com" adresini kullan.
2. Footer kısmındaki "Abone ol" linki için kesinlikle \`mailto:chatixai.business@outlook.com?subject=ChatixAI%20Abone%20Olmak%20İstiyorum\` linkini kullan.
3. Mailin en üst kısmına şık logo kutusu yerleştir: "Chatix" saf beyaz (#ffffff), "AI" ise turkuaz (#00f2fe) olsun.
4. Telif veya alt bilgi (footer) alanında yılı kesinlikle "2026" olarak yaz (Asla 2025 yazma).

ÇIKTI FORMATI ZORUNLULUĞU:
Yalnızca ve yalnızca aşağıdaki JSON formatında yanıt ver. Markdown kod blokları (\`\`\`json vb.), hiçbir ek açıklama veya ön metin EKLEME.

{
  "subject": "E-posta Konu Başlığı (Emoji içerebilir)",
  "htmlContent": "<div style=\\"...\\">Tüm HTML Kodları Inline CSS Ile Burada</div>"
}
`;

// 4. Kullanıcıların Abone Olması İçin Rota (API)
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: "E-posta adresi gerekli." });
        }
        await db.collection('subscribers').doc(email).set({
            email: email,
            subscribedAt: new Date().toISOString()
        });
        res.json({ success: true, message: "Başarıyla abone olundu!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Bülten Oluşturma ve Firebase'deki Abonelere Gönderme Rotası
app.post('/api/send-newsletter', async (req, res) => {
    try {
        const { promptText } = req.body;
        if (!promptText) {
            return res.status(400).json({ success: false, error: "Prompt metni eksik." });
        }
        
        // Gemini API Çağrısı (Model Fallback zinciri ile)
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        let responseText = "";
        const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-3.5-flash'];
        
        for (const modelName of models) {
            try {
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: promptText,
                    config: {
                        systemInstruction: systemInstruction,
                        responseMimeType: "application/json"
                    }
                });
                responseText = response.text;
                if (responseText) break;
            } catch (err) {
                console.log(`${modelName} başarısız oldu, sonrakine geçiliyor...`);
            }
        }

        if (!responseText) {
            throw new Error("Hiçbir Gemini modelinden yanıt alınamadı.");
        }

        let cleanText = responseText.trim();
        if (cleanText.startsWith("```json")) {
            cleanText = cleanText.replace(/^```json/, "").replace(/```$/, "").trim();
        } else if (cleanText.startsWith("```")) {
            cleanText = cleanText.replace(/^```/, "").replace(/```$/, "").trim();
        }

        const emailData = JSON.parse(cleanText);

        const subscribersSnapshot = await db.collection('subscribers').get();
        const subscribers = [];
        subscribersSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.email) {
                subscribers.push(data.email);
            }
        });

        if (subscribers.length === 0) {
            return res.status(400).json({ success: false, error: "Firebase'de kayıtlı abone bulunamadı." });
        }

        let sentCount = 0;
        for (const email of subscribers) {
            try {
                await transporter.sendMail({
                    from: '"ChatixAI" <chatixai.business@outlook.com>',
                    to: email,
                    subject: emailData.subject,
                    html: emailData.htmlContent
                });
                sentCount++;
            } catch (mailErr) {
                console.error(`E-posta gönderilemedi (${email}):`, mailErr.message);
            }
        }
        
        res.json({ 
            success: true, 
            message: `Bülten başarıyla oluşturuldu ve ${sentCount} aboneye gönderildi!`, 
            subject: emailData.subject 
        });

    } catch (error) {
        console.error("Sunucu Hatası:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin sayfası için özel rota (opsiyonel, public/admin.html doğrudan da açılabilir)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ChatixAI sunucusu ${PORT} portunda ayakta! 🚀`);
});
