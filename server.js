const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// 1. التحقق من بيانات تيليجرام
// ==========================================
function verifyTelegramData(initData) {
    try {
        if (!initData) return false;
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        if (!hash) return false;
        urlParams.delete('hash');
        const keys = [...urlParams.keys()].sort();
        let dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');
        const secret = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
        return computedHash === hash;
    } catch (e) { return false; }
}

// ==========================================
// 2. الاتصال بقاعدة البيانات
// ==========================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ متصل بـ MongoDB'))
  .catch(err => console.error('❌ فشل الاتصال:', err));

// ==========================================
// 3. نماذج قاعدة البيانات
// ==========================================
const CounterSchema = new mongoose.Schema({ _id: String, count: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', CounterSchema);

const UserSchema = new mongoose.Schema({
    telegram_id: { type: Number, unique: true, sparse: true },
    username: String,
    email: { type: String, unique: true, sparse: true },
    password: String,
    device_fingerprint: String,
    ip_address: String,
    points: { type: Number, default: 0 },
    max_clicks: { type: Number, default: 1000 },
    clicks_used: { type: Number, default: 0 },
    referral_code: { type: String, unique: true },
    referred_by: { type: Number, default: null },
    referrals_count: { type: Number, default: 0 },
    role: { type: String, default: 'user' },
    is_banned: { type: Boolean, default: false },
    last_click: Date,
    created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const SettingsSchema = new mongoose.Schema({
    _id: String,
    mining_open: { type: Boolean, default: false },
    vtx_price: { type: Number, default: 0.1387 }
});
const Settings = mongoose.model('Settings', SettingsSchema);

const PurchaseSchema = new mongoose.Schema({
    user_id: Number,
    username: String,
    amount: Number,
    txid: String,
    status: { type: String, default: 'pending' },
    created_at: { type: Date, default: Date.now }
});
const Purchase = mongoose.model('Purchase', PurchaseSchema);

// ==========================================
// 4. دوال مساعدة
// ==========================================
const generateFingerprint = (ip, ua, id) => {
    return crypto.createHash('sha256').update(`${ip}_${ua}_${id}`).digest('hex');
};

// ==========================================
// 5. إعدادات Express
// ==========================================
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ==========================================
// 6. جلب المستخدم من الجلسة
// ==========================================
async function getUserFromSession(req) {
    const sessionId = req.cookies?.user_session;
    if (sessionId) {
        const user = await User.findById(sessionId);
        if (user) return user;
    }
    return null;
}

// ==========================================
// 7. API المصادقة
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, phone, email, password } = req.body;
        if (!email || !password) {
            return res.json({ success: false, message: 'البريد الإلكتروني وكلمة المرور مطلوبة' });
        }
        const existing = await User.findOne({ email });
        if (existing) {
            return res.json({ success: false, message: 'البريد الإلكتروني مسجل مسبقاً' });
        }
        const referral_code = `VTX_${Date.now()}_${Math.floor(Math.random()*1000)}`;
        const user = new User({
            username: name || email.split('@')[0],
            email: email,
            password: password,
            referral_code: referral_code,
            points: 0,
            role: 'user'
        });
        await user.save();
        await Counter.findByIdAndUpdate('total_users', { $inc: { count: 1 } }, { upsert: true });
        res.json({ success: true, message: '✅ تم إنشاء الحساب بنجاح', user: { email: user.email, username: user.username } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.json({ success: false, message: 'البريد الإلكتروني وكلمة المرور مطلوبة' });
        }
        const user = await User.findOne({ email });
        if (!user) {
            return res.json({ success: false, message: 'البريد الإلكتروني غير مسجل' });
        }
        if (user.password !== password) {
            return res.json({ success: false, message: 'كلمة المرور غير صحيحة' });
        }
        res.cookie('user_session', user._id.toString(), { maxAge: 7*24*60*60*1000, httpOnly: true, sameSite: 'lax' });
        res.json({ success: true, message: '✅ تم تسجيل الدخول', user: { email: user.email, username: user.username, points: user.points } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('user_session');
    res.json({ success: true, message: 'تم تسجيل الخروج' });
});

// ==========================================
// 8. الصفحة الرئيسية
// ==========================================
app.get('/app', async (req, res) => {
    try {
        const { initData } = req.query;
        let telegram_id = null;
        let username = 'زائر';

        if (initData && verifyTelegramData(initData)) {
            try {
                const urlParams = new URLSearchParams(initData);
                const userData = JSON.parse(urlParams.get('user'));
                telegram_id = userData.id;
                username = userData.username || `User_${telegram_id}`;
            } catch (e) {
                telegram_id = parseInt(req.query.user_id) || null;
                username = req.query.username || 'زائر';
            }
        } else {
            telegram_id = parseInt(req.query.user_id) || null;
            username = req.query.username || 'زائر';
        }

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        let user = null;

        if (telegram_id && telegram_id !== 'null') {
            user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        }

        if (!user) {
            user = await getUserFromSession(req);
        }

        if (telegram_id && telegram_id !== 'null' && !user) {
            const fingerprint = generateFingerprint(ip, userAgent, telegram_id);
            const existing = await User.findOne({ device_fingerprint: fingerprint });
            if (!existing) {
                const referral_code = `VTX_${telegram_id}`;
                user = new User({
                    telegram_id: parseInt(telegram_id),
                    username: username,
                    device_fingerprint: fingerprint,
                    ip_address: ip,
                    referral_code: referral_code,
                    points: 0,
                    role: 'user'
                });
                await user.save();
                await Counter.findByIdAndUpdate('total_users', { $inc: { count: 1 } }, { upsert: true });
            } else {
                return res.send('<h1>⚠️ هذا الجهاز مسجل بحساب آخر</h1>');
            }
        }

        if (!user) {
            user = {
                telegram_id: null,
                username: username,
                points: 0,
                max_clicks: 1000,
                clicks_used: 0,
                referral_code: 'غير مسجل',
                referrals_count: 0,
                role: 'user',
                is_banned: false
            };
        }

        const settings = await Settings.findById('main_config');
        const miningOpen = settings?.mining_open || false;
        const currentPrice = settings?.vtx_price || 0.1387;
        const counter = await Counter.findById('total_users');
        const totalUsers = counter?.count || 0;

        const htmlPath = path.join(__dirname, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace(/\{\{TELEGRAM_ID\}\}/g, user.telegram_id || 'null');
        html = html.replace(/\{\{USERNAME\}\}/g, user.username || 'زائر');
        html = html.replace(/\{\{POINTS\}\}/g, user.points || 0);
        html = html.replace(/\{\{MAX_CLICKS\}\}/g, user.max_clicks || 1000);
        html = html.replace(/\{\{CLICKS_USED\}\}/g, user.clicks_used || 0);
        html = html.replace(/\{\{TOTAL_USERS\}\}/g, totalUsers || 0);
        html = html.replace(/\{\{MINING_OPEN\}\}/g, miningOpen ? 'true' : 'false');
        html = html.replace(/\{\{PROGRESS\}\}/g, Math.min((totalUsers / 20000) * 100, 100));
        html = html.replace(/\{\{REFERRAL_CODE\}\}/g, user.referral_code || 'غير متاح');
        html = html.replace(/\{\{REFERRALS_COUNT\}\}/g, user.referrals_count || 0);
        html = html.replace(/\{\{USDT_WALLET\}\}/g, process.env.USDT_WALLET || '0x...');
        html = html.replace(/\{\{VTX_PRICE\}\}/g, currentPrice);
        html = html.replace(/\{\{USER_ROLE\}\}/g, user.role || 'user');

        res.send(html);
    } catch (error) {
        console.error("❌ خطأ في /app:", error);
        res.status(500).send(`<h1>خطأ داخلي: ${error.message}</h1>`);
    }
});

// ==========================================
// 9. API الحالة العامة
// ==========================================
app.get('/api/status', async (req, res) => {
    try {
        const { telegram_id } = req.query;
        let user = null;
        if (telegram_id && telegram_id !== 'null') {
            user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        }
        if (!user) {
            user = await getUserFromSession(req);
        }
        if (!user) {
            return res.status(404).json({ error: 'غير مسجل' });
        }

        const counter = await Counter.findById('total_users');
        const settings = await Settings.findById('main_config');

        res.json({
            total_users: counter?.count || 0,
            mining_open: settings?.mining_open || false,
            points: user.points || 0,
            max_clicks: user.max_clicks || 1000,
            clicks_used: user.clicks_used || 0,
            progress: Math.min((user.clicks_used / user.max_clicks) * 100, 100),
            referrals_count: user.referrals_count || 0,
            referral_code: user.referral_code || 'غير متاح',
            vtx_price: settings?.vtx_price || 0.1387,
            role: user.role || 'user',
            username: user.username || 'زائر'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 10. API التعدين
// ==========================================
const cooldowns = {};
app.post('/api/click', async (req, res) => {
    try {
        const { telegram_id } = req.body;
        let user = null;
        if (telegram_id && telegram_id !== 'null') {
            user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        }
        if (!user) {
            user = await getUserFromSession(req);
        }
        if (!user) return res.json({ success: false, message: 'غير مسجل' });
        if (user.is_banned) return res.json({ success: false, message: 'محظور' });
        if (user.clicks_used >= user.max_clicks) {
            return res.json({ success: false, message: 'استنفذت كل الضغطات' });
        }

        const settings = await Settings.findById('main_config');
        if (!settings?.mining_open) {
            return res.json({ success: false, message: 'التعدين لم يفتح بعد' });
        }

        const now = Date.now();
        const last = cooldowns[user._id.toString()] || 0;
        if ((now - last) < 3000) {
            return res.status(429).json({
                success: false,
                message: 'انتظر 3 ثوانٍ',
                wait: 3 - (now - last) / 1000
            });
        }
        cooldowns[user._id.toString()] = now;

        user.points += 1;
        user.clicks_used += 1;
        user.last_click = new Date();
        await user.save();

        res.json({
            success: true,
            message: '+1 نقطة',
            new_points: user.points,
            clicks_used: user.clicks_used,
            max_clicks: user.max_clicks,
            progress: Math.min((user.clicks_used / user.max_clicks) * 100, 100)
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 11. API شراء المعززات
// ==========================================
app.post('/api/buy_boost', async (req, res) => {
    try {
        const { telegram_id, boost_type } = req.body;
        let user = null;
        if (telegram_id && telegram_id !== 'null') {
            user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        }
        if (!user) {
            user = await getUserFromSession(req);
        }
        if (!user) return res.json({ success: false, message: 'غير مسجل' });

        const boostMap = {
            silver: { cost: 10, extra: 500 },
            gold: { cost: 25, extra: 1500 },
            titan: { cost: 100, extra: 5000 }
        };

        const boost = boostMap[boost_type];
        if (!boost) return res.json({ success: false, message: 'نوع معزز غير صالح' });

        user.max_clicks += boost.extra;
        await user.save();

        res.json({
            success: true,
            message: `✅ تم شراء ${boost_type}، تمت إضافة ${boost.extra} ضغطة`,
            new_max: user.max_clicks
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 12. API طلب شراء USDT (Pre-sale)
// ==========================================
app.post('/api/purchase', async (req, res) => {
    try {
        const { telegram_id, amount, txid } = req.body;
        if (!amount || !txid || amount <= 0) return res.json({ success: false, message: 'بيانات ناقصة' });

        let user = null;
        if (telegram_id && telegram_id !== 'null') {
            user = await User.findOne({ telegram_id: parseInt(telegram_id) });
        }
        if (!user) {
            user = await getUserFromSession(req);
        }
        if (!user) return res.json({ success: false, message: 'غير مسجل' });

        const existing = await Purchase.findOne({ txid });
        if (existing) return res.json({ success: false, message: 'رقم المعاملة مستخدم مسبقاً' });

        const purchase = new Purchase({
            user_id: user.telegram_id || user._id,
            username: user.username,
            amount: parseFloat(amount),
            txid: txid,
            status: 'pending'
        });
        await purchase.save();

        res.json({ success: true, message: '✅ تم استلام طلبك، سيتم التحقق منه يدوياً قريباً.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 13. لوحة الإدارة (Admin)
// ==========================================
app.get('/admin', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Vortex Admin</title>
    <style>body{background:#0b0e1a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;}
    .box{background:#161f3a;padding:40px;border-radius:20px;border:1px solid #f5c842;min-width:300px;}
    input,button{display:block;width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #2f3a66;background:#0d1428;color:#fff;}
    button{background:#f5c842;color:#000;font-weight:bold;cursor:pointer;}
    </style></head>
    <body><div class="box"><h2 style="color:#f5c842;">🔐 Vortex Admin</h2>
    <form action="/admin/login" method="post">
    <input type="password" name="password" placeholder="كلمة المرور" required>
    <button type="submit">دخول</button>
    </form></div></body></html>`;
    res.send(html);
});

app.post('/admin/login', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        res.cookie('admin_auth', 'true', { maxAge: 3600000, httpOnly: true });
        res.redirect('/admin/dashboard');
    } else {
        res.send('<h1>❌ كلمة مرور خاطئة</h1><a href="/admin">عودة</a>');
    }
});

const authMiddleware = (req, res, next) => {
    if (req.cookies?.admin_auth === 'true') return next();
    res.redirect('/admin');
};

app.get('/admin/dashboard', authMiddleware, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalPoints = await User.aggregate([{ $group: { _id: null, total: { $sum: '$points' } } }]);
        const pendingPurchases = await Purchase.find({ status: 'pending' });
        const users = await User.find({}, 'telegram_id username points referral_code referrals_count').limit(50);
        const settings = await Settings.findById('main_config');
        const currentPrice = settings?.vtx_price || 0.1387;

        let html = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Vortex Admin</title>
        <style>
        body{background:#0b0e1a;color:#e0e0e0;font-family:sans-serif;padding:20px;direction:rtl;}
        .container{max-width:1200px;margin:auto;}
        .card{background:#161f3a;padding:20px;border-radius:16px;border:1px solid #2f3a66;margin:10px 0;}
        table{width:100%;border-collapse:collapse;}
        th,td{padding:10px;border-bottom:1px solid #2f3a66;text-align:right;}
        th{color:#f5c842;}
        .btn{background:#f5c842;color:#000;border:none;padding:6px 14px;border-radius:20px;cursor:pointer;}
        .btn-danger{background:#ff4444;color:#fff;}
        .btn-success{background:#44bb44;color:#fff;}
        .btn-primary{background:#1a8cff;color:#fff;}
        .badge{padding:4px 12px;border-radius:30px;font-size:12px;}
        .badge-pending{background:#f5a623;color:#000;}
        .badge-approved{background:#44bb44;color:#fff;}
        .badge-rejected{background:#ff4444;color:#fff;}
        input{background:#0d1428;border:1px solid #2f3a66;padding:8px;border-radius:8px;color:#fff;}
        .flex{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
        </style></head>
        <body><div class="container">
        <h1 style="color:#f5c842;">⚡ Vortex Admin</h1>
        <div class="card">
            <h3>📊 الإحصائيات</h3>
            <p>👥 المستخدمين: ${totalUsers}</p>
            <p>⭐ إجمالي النقاط: ${totalPoints[0]?.total || 0}</p>
            <p>🟡 طلبات الشراء المعلقة: ${pendingPurchases.length}</p>
            <p>💰 سعر VTX الحالي: <span style="color:#f5c842;font-weight:bold;">${currentPrice} USDT</span></p>
        </div>
        <div class="card">
            <h3>💲 تحديث سعر العملة</h3>
            <form action="/admin/set_price" method="post" class="flex">
                <input type="number" step="0.0001" name="price" value="${currentPrice}" style="width:200px;">
                <button type="submit" class="btn btn-primary">تحديث السعر</button>
            </form>
        </div>
        <div class="card"><h3>🟡 طلبات الشراء (USDT)</h3><table>
        <tr><th>المستخدم</th><th>المبلغ</th><th>TXID</th><th>الحالة</th><th>إجراء</th></tr>`;
        for (const p of pendingPurchases) {
            html += `<tr><td>${p.username}</td><td>${p.amount} USDT</td><td style="font-size:12px;word-break:break-all;">${p.txid}</td>
            <td><span class="badge badge-pending">قيد المراجعة</span></td>
            <td>
            <form action="/admin/approve_purchase" method="post" style="display:inline;">
            <input type="hidden" name="purchase_id" value="${p._id}">
            <button class="btn btn-success" type="submit">✅ تأكيد</button>
            </form>
            <form action="/admin/reject_purchase" method="post" style="display:inline;">
            <input type="hidden" name="purchase_id" value="${p._id}">
            <button class="btn btn-danger" type="submit">❌ رفض</button>
            </form>
            </td></tr>`;
        }
        html += `</table></div>
        <div class="card"><h3>👤 المستخدمون (آخر 50)</h3>
        <table><tr><th>ID</th><th>اسم المستخدم</th><th>النقاط</th><th>كود الإحالة</th><th>مدعوين</th></tr>`;
        for (const u of users) {
            html += `<tr><td>${u.telegram_id || 'بريد'}</td><td>${u.username}</td><td>${u.points}</td><td>${u.referral_code}</td><td>${u.referrals_count || 0}</td></tr>`;
        }
        html += `</table></div>
        <div class="card"><h3>📨 إرسال إشعار جماعي</h3>
        <form action="/admin/broadcast" method="post">
        <textarea name="message" rows="3" style="width:100%;padding:10px;border-radius:8px;background:#0d1428;color:#fff;border:1px solid #2f3a66;"></textarea>
        <button class="btn" type="submit">إرسال للجميع</button>
        </form></div>
        <a href="/admin/logout" style="color:#f5c842;">تسجيل الخروج</a>
        </div></body></html>`;
        res.send(html);
    } catch (e) { res.status(500).send('خطأ: ' + e.message); }
});

app.post('/admin/set_price', authMiddleware, async (req, res) => {
    try {
        const { price } = req.body;
        if (!price || parseFloat(price) <= 0) return res.redirect('/admin/dashboard');
        await Settings.findByIdAndUpdate('main_config', { vtx_price: parseFloat(price) }, { upsert: true });
        res.redirect('/admin/dashboard');
    } catch (e) { res.status(500).send('خطأ'); }
});

app.post('/admin/approve_purchase', authMiddleware, async (req, res) => {
    try {
        const { purchase_id } = req.body;
        const purchase = await Purchase.findById(purchase_id);
        if (!purchase) return res.redirect('/admin/dashboard');
        purchase.status = 'approved';
        await purchase.save();
        await User.findOneAndUpdate({ telegram_id: purchase.user_id }, { $inc: { points: purchase.amount * 100 } });
        res.redirect('/admin/dashboard');
    } catch (e) { res.status(500).send('خطأ'); }
});

app.post('/admin/reject_purchase', authMiddleware, async (req, res) => {
    try {
        const { purchase_id } = req.body;
        await Purchase.findByIdAndUpdate(purchase_id, { status: 'rejected' });
        res.redirect('/admin/dashboard');
    } catch (e) { res.status(500).send('خطأ'); }
});

app.post('/admin/broadcast', authMiddleware, async (req, res) => {
    console.log(`📨 إشعار جماعي: ${req.body.message}`);
    res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => {
    res.clearCookie('admin_auth');
    res.redirect('/admin');
});

// ==========================================
// 14. مسار تجريبي
// ==========================================
app.get('/', (req, res) => {
    res.send('🚀 مشروع Vortex يعمل بنجاح!');
});

// ==========================================
// 15. تشغيل السيرفر
// ==========================================
app.listen(PORT, () => {
    console.log(`✅ سيرفر Vortex يعمل على المنفذ ${PORT}`);
});
