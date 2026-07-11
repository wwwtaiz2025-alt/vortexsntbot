const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ==============================
// 1. الإعدادات الأساسية
// ==============================
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// التأكد من وجود مجلد uploads
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// ==============================
// 2. التحقق من وجود index.html
// ==============================
const indexPath = path.join(__dirname, 'index.html');
if (!fs.existsSync(indexPath)) {
    console.error('❌ ملف index.html غير موجود في المسار:', indexPath);
    console.error('⚠️ تأكد من رفع الملف إلى المستودع بنفس الاسم');
    process.exit(1);
} else {
    console.log('✅ تم العثور على index.html');
}

// ==============================
// 3. الاتصال بقاعدة البيانات
// ==============================
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('✅ متصل بـ MongoDB'))
.catch(err => {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
    console.error('⚠️ تأكد من متغير MONGO_URI في البيئة');
    process.exit(1);
});

// ==============================
// 4. نماذج قاعدة البيانات
// ==============================
const UserSchema = new mongoose.Schema({
    telegram_id: { type: Number, unique: false, sparse: true, default: null },
    username: { type: String, default: 'مستخدم' },
    email: { type: String, unique: true, sparse: true },
    password: { type: String },
    balance_vrt: { type: Number, default: 0 },
    balance_usdt: { type: Number, default: 0 },
    captcha_passed: { type: Boolean, default: false },
    referral_code: { type: String, unique: true },
    referred_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    total_ref_earnings: { type: Number, default: 0 },
    mining_start_time: { type: Date, default: null },
    is_mining_active: { type: Boolean, default: false },
    mining_daily_reward: { type: Number, default: 0 },
    role: { type: String, default: 'user' },
    is_banned: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    user_telegram_id: Number,
    amount_usdt: Number,
    amount_vrt: Number,
    txid: { type: String, unique: true },
    status: { type: String, default: 'pending' },
    rejection_reason: { type: String, default: '' },
    screenshot_url: { type: String, default: '' },
    warning_flag: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});

const TaskSchema = new mongoose.Schema({
    title: String,
    reward_vrt: Number,
    type: { type: String, enum: ['telegram_join', 'survey'] },
    channel_username: { type: String, default: '' },
    is_active: { type: Boolean, default: true }
});

const AdminLogSchema = new mongoose.Schema({
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    admin_telegram_id: Number,
    action: String,
    target_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now }
});

const SettingsSchema = new mongoose.Schema({
    _id: { type: String, default: 'main_config' },
    vtx_price: { type: Number, default: 0.1461 },
    target_price: { type: Number, default: 8.00 },
    total_supply: { type: Number, default: 100000000 },
    liquidity: { type: Number, default: 15000000 },
    mining_open: { type: Boolean, default: true },
    mining_total_seats: { type: Number, default: 100000 },
    mining_total_vrt: { type: Number, default: 15000000 },
    mining_current_seats: { type: Number, default: 0 },
    mining_current_vrt: { type: Number, default: 0 }
});

const ReferralEarningSchema = new mongoose.Schema({
    referrer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referred_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    amount: Number,
    day: Number,
    created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const Task = mongoose.model('Task', TaskSchema);
const AdminLog = mongoose.model('AdminLog', AdminLogSchema);
const Settings = mongoose.model('Settings', SettingsSchema);
const ReferralEarning = mongoose.model('ReferralEarning', ReferralEarningSchema);

// ==============================
// 5. دوال مساعدة
// ==============================

function generateReferralCode() {
    return 'VRT_' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function verifyCaptcha(answer, expected) {
    return parseInt(answer) === parseInt(expected);
}

async function getUserFromRequest(req) {
    const token = req.cookies?.token;
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'vortex-secret-key');
        const user = await User.findById(decoded.id);
        return user;
    } catch (e) {
        return null;
    }
}

// ==============================
// 6. إنشاء الإعدادات الافتراضية
// ==============================
async function initSettings() {
    const settings = await Settings.findById('main_config');
    if (!settings) {
        const newSettings = new Settings({ _id: 'main_config' });
        await newSettings.save();
        console.log('✅ تم إنشاء الإعدادات الافتراضية');
    }
}
initSettings();

// ==============================
// 7. API المصادقة
// ==============================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, captcha_answer, captcha_expected, referral_code } = req.body;

        if (!verifyCaptcha(captcha_answer, captcha_expected)) {
            return res.json({ success: false, message: '❌ إجابة الكابتشا غير صحيحة' });
        }

        const existing = await User.findOne({ email });
        if (existing) {
            return res.json({ success: false, message: '❌ البريد الإلكتروني مسجل مسبقاً' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        let refCode = generateReferralCode();
        while (await User.findOne({ referral_code: refCode })) {
            refCode = generateReferralCode();
        }

        let referredBy = null;
        if (referral_code) {
            const referrer = await User.findOne({ referral_code });
            if (referrer) {
                referredBy = referrer._id;
            }
        }

        const user = new User({
            username: username || email.split('@')[0],
            email,
            password: hashedPassword,
            referral_code: refCode,
            referred_by: referredBy,
            captcha_passed: true,
            role: 'user',
            telegram_id: null
        });
        await user.save();

        await Settings.findByIdAndUpdate('main_config', {
            $inc: { mining_current_seats: 1 }
        }, { upsert: true });

        const token = jwt.sign(
            { id: user._id, role: user.role },
            process.env.JWT_SECRET || 'vortex-secret-key',
            { expiresIn: '7d' }
        );
        res.cookie('token', token, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });

        res.json({
            success: true,
            message: '✅ تم إنشاء الحساب بنجاح',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                balance_vrt: user.balance_vrt,
                role: user.role
            }
        });

    } catch (e) {
        console.error('Register error:', e);
        res.status(500).json({ success: false, message: '⚠️ خطأ داخلي: ' + e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.json({ success: false, message: '❌ البريد الإلكتروني وكلمة المرور مطلوبة' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.json({ success: false, message: '❌ البريد الإلكتروني غير مسجل' });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.json({ success: false, message: '❌ كلمة المرور غير صحيحة' });
        }

        const token = jwt.sign(
            { id: user._id, role: user.role },
            process.env.JWT_SECRET || 'vortex-secret-key',
            { expiresIn: '7d' }
        );
        res.cookie('token', token, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });

        res.json({
            success: true,
            message: '✅ تم تسجيل الدخول بنجاح',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                balance_vrt: user.balance_vrt,
                role: user.role
            }
        });

    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ success: false, message: '⚠️ خطأ داخلي: ' + e.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true, message: 'تم تسجيل الخروج' });
});

app.get('/api/auth/me', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) {
            return res.status(401).json({ error: 'غير مسجل' });
        }
        res.json({
            id: user._id,
            username: user.username,
            email: user.email,
            balance_vrt: user.balance_vrt,
            balance_usdt: user.balance_usdt,
            role: user.role,
            referral_code: user.referral_code,
            is_mining_active: user.is_mining_active,
            mining_start_time: user.mining_start_time
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==============================
// 8. نظام التعدين
// ==============================
app.get('/api/mining/status', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'غير مسجل' });

        const settings = await Settings.findById('main_config');

        let remainingSeconds = null;
        if (user.is_mining_active && user.mining_start_time) {
            const endTime = new Date(user.mining_start_time.getTime() + 24 * 60 * 60 * 1000);
            const now = new Date();
            if (endTime > now) {
                remainingSeconds = Math.floor((endTime - now) / 1000);
            } else {
                user.is_mining_active = false;
                user.balance_vrt += user.mining_daily_reward || 1;
                await user.save();
                remainingSeconds = 0;
            }
        }

        res.json({
            is_mining_active: user.is_mining_active,
            mining_start_time: user.mining_start_time,
            mining_daily_reward: user.mining_daily_reward || 0,
            remaining_seconds: remainingSeconds,
            balance_vrt: user.balance_vrt,
            total_seats: settings?.mining_total_seats || 100000,
            current_seats: settings?.mining_current_seats || 0,
            total_vrt: settings?.mining_total_vrt || 15000000,
            current_vrt: settings?.mining_current_vrt || 0,
            mining_open: settings?.mining_open || false
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/mining/start', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: 'غير مسجل' });
        if (user.is_banned) return res.json({ success: false, message: 'حسابك محظور' });

        const settings = await Settings.findById('main_config');
        if (!settings || !settings.mining_open) {
            return res.json({ success: false, message: '⛔ التعدين متوقف حالياً' });
        }

        if (settings.mining_current_seats >= settings.mining_total_seats) {
            return res.json({ success: false, message: '❌ نفذت المقاعد المخصصة للتعدين' });
        }

        if (user.is_mining_active) {
            return res.json({ success: false, message: '⏳ لديك دورة تعدين نشطة حالياً' });
        }

        user.is_mining_active = true;
        user.mining_start_time = new Date();
        user.mining_daily_reward = 1;
        await user.save();

        await Settings.findByIdAndUpdate('main_config', {
            $inc: { mining_current_seats: 1, mining_current_vrt: 1 }
        });

        res.json({
            success: true,
            message: '✅ بدأت دورة التعدين بنجاح',
            mining_start_time: user.mining_start_time,
            mining_daily_reward: user.mining_daily_reward
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==============================
// 9. الشراء المسبق
// ==============================

const upload = multer({
    storage: multer.diskStorage({
        destination: 'uploads/',
        filename: (req, file, cb) => {
            const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'purchase_' + unique + '.png');
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/purchase/submit', upload.single('screenshot'), async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: 'غير مسجل' });

        const { amount_usdt, txid } = req.body;
        const screenshot = req.file;

        if (!amount_usdt || amount_usdt < 3 || amount_usdt > 500) {
            return res.json({ success: false, message: '⚠️ المبلغ بين 3 و 500 USDT' });
        }
        if (!txid || txid.length < 5) {
            return res.json({ success: false, message: '⚠️ أدخل رقم معاملة صحيح' });
        }

        const existing = await Transaction.findOne({ txid });
        if (existing) {
            return res.json({ success: false, message: '⚠️ رقم المعاملة مستخدم مسبقاً' });
        }

        const settings = await Settings.findById('main_config');
        const price = settings?.vtx_price || 0.1461;
        const amount_vrt = amount_usdt / price;

        const transaction = new Transaction({
            user_id: user._id,
            user_telegram_id: user.telegram_id,
            amount_usdt: parseFloat(amount_usdt),
            amount_vrt: parseFloat(amount_vrt),
            txid: txid,
            status: 'pending',
            screenshot_url: screenshot ? '/uploads/' + screenshot.filename : '',
            warning_flag: false
        });
        await transaction.save();

        res.json({
            success: true,
            message: '✅ تم استلام طلبك، قيد المراجعة الإدارية',
            transaction_id: transaction._id
        });
    } catch (e) {
        console.error('Purchase submit error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/purchase/history', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'غير مسجل' });

        const transactions = await Transaction.find({ user_id: user._id })
            .sort({ created_at: -1 })
            .limit(50);

        res.json({ transactions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==============================
// 10. المهام
// ==============================
app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await Task.find({ is_active: true });
        res.json({ tasks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==============================
// 11. الإحالات
// ==============================
app.get('/api/referrals', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'غير مسجل' });

        const referredUsers = await User.find({ referred_by: user._id }, 'username balance_vrt created_at');

        const totalEarnings = await ReferralEarning.aggregate([
            { $match: { referrer_id: user._id } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        res.json({
            referral_code: user.referral_code,
            total_referrals: referredUsers.length,
            total_earnings: totalEarnings[0]?.total || 0,
            referred_users: referredUsers.map(u => ({
                username: u.username,
                balance: u.balance_vrt,
                joined_at: u.created_at
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==============================
// 11.5. الإعلانات (Ads)
// ==============================
app.post('/api/ads/watch', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: 'غير مسجل' });

        const { adsWatched } = req.body;
        const earned = Math.floor(adsWatched / 10);

        if (earned > 0) {
            user.balance_vrt = (user.balance_vrt || 0) + earned;
            await user.save();
        }

        res.json({
            success: true,
            message: '✅ تم مشاهدة الإعلان',
            earned: earned,
            balance_vrt: user.balance_vrt
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==============================
// 12. لوحة الإدارة
// ==============================
app.get('/admin/stats', async (req, res) => {
    try {
        const admin = await getUserFromRequest(req);
        if (!admin || admin.role !== 'admin') {
            return res.status(403).json({ error: 'غير مصرح' });
        }

        const totalUsers = await User.countDocuments();
        const totalVRT = await User.aggregate([{ $group: { _id: null, total: { $sum: '$balance_vrt' } } }]);
        const pendingPurchases = await Transaction.countDocuments({ status: 'pending' });
        const settings = await Settings.findById('main_config');

        res.json({
            totalUsers,
            totalVRT: totalVRT[0]?.total || 0,
            pendingPurchases,
            vtx_price: settings?.vtx_price || 0.1461,
            mining_current_seats: settings?.mining_current_seats || 0,
            mining_total_seats: settings?.mining_total_seats || 100000
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin/pending_purchases', async (req, res) => {
    try {
        const admin = await getUserFromRequest(req);
        if (!admin || admin.role !== 'admin') {
            return res.status(403).json({ error: 'غير مصرح' });
        }

        const transactions = await Transaction.find({ status: 'pending' })
            .populate('user_id', 'username email telegram_id')
            .sort({ created_at: 1 });

        res.json({ transactions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/approve_purchase', async (req, res) => {
    try {
        const admin = await getUserFromRequest(req);
        if (!admin || admin.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'غير مصرح' });
        }

        const { transaction_id } = req.body;
        const transaction = await Transaction.findById(transaction_id);
        if (!transaction) {
            return res.json({ success: false, message: 'الطلب غير موجود' });
        }
        if (transaction.status !== 'pending') {
            return res.json({ success: false, message: 'تمت مراجعة هذا الطلب مسبقاً' });
        }

        transaction.status = 'approved';
        await transaction.save();

        const user = await User.findById(transaction.user_id);
        if (user) {
            user.balance_vrt += transaction.amount_vrt;
            user.balance_usdt += transaction.amount_usdt;
            await user.save();
        }

        res.json({ success: true, message: '✅ تم قبول المعاملة وإضافة الرصيد' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/reject_purchase', async (req, res) => {
    try {
        const admin = await getUserFromRequest(req);
        if (!admin || admin.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'غير مصرح' });
        }

        const { transaction_id, reason } = req.body;
        if (!reason || reason.length < 3) {
            return res.json({ success: false, message: 'الرجاء كتابة سبب الرفض' });
        }

        const transaction = await Transaction.findById(transaction_id);
        if (!transaction) {
            return res.json({ success: false, message: 'الطلب غير موجود' });
        }
        if (transaction.status !== 'pending') {
            return res.json({ success: false, message: 'تمت مراجعة هذا الطلب مسبقاً' });
        }

        transaction.status = 'rejected';
        transaction.rejection_reason = reason;
        await transaction.save();

        res.json({ success: true, message: '❌ تم رفض المعاملة' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/set_price', async (req, res) => {
    try {
        const admin = await getUserFromRequest(req);
        if (!admin || admin.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'غير مصرح' });
        }

        const { price } = req.body;
        if (!price || price <= 0) {
            return res.json({ success: false, message: 'سعر غير صالح' });
        }

        await Settings.findByIdAndUpdate('main_config', { vtx_price: parseFloat(price) }, { upsert: true });
        res.json({ success: true, message: '✅ تم تحديث السعر' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/broadcast', async (req, res) => {
    try {
        const admin = await getUserFromRequest(req);
        if (!admin || admin.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'غير مصرح' });
        }

        const { message } = req.body;
        if (!message || message.length < 3) {
            return res.json({ success: false, message: 'الرسالة قصيرة جداً' });
        }

        console.log(`📨 إشعار جماعي من ${admin.username}: ${message}`);
        res.json({ success: true, message: '✅ تم إرسال الإشعار للجميع' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==============================
// 13. الصفحة الرئيسية (Mini-App)
// ==============================
app.get('/app', async (req, res) => {
    try {
        const user = await getUserFromRequest(req);
        const settings = await Settings.findById('main_config');

        // التحقق من وجود الملف قبل القراءة
        if (!fs.existsSync(indexPath)) {
            return res.status(500).send('❌ ملف index.html غير موجود');
        }

        let html = fs.readFileSync(indexPath, 'utf8');

        const userData = user ? {
            id: user._id,
            username: user.username,
            balance_vrt: user.balance_vrt,
            balance_usdt: user.balance_usdt,
            role: user.role,
            referral_code: user.referral_code,
            is_mining_active: user.is_mining_active,
            mining_start_time: user.mining_start_time
        } : null;

        html = html.replace(/\{\{USER_DATA\}\}/g, JSON.stringify(userData));
        html = html.replace(/\{\{VTX_PRICE\}\}/g, settings?.vtx_price || 0.1461);
        html = html.replace(/\{\{TARGET_PRICE\}\}/g, settings?.target_price || 8.00);
        html = html.replace(/\{\{TOTAL_SUPPLY\}\}/g, settings?.total_supply || 100000000);
        html = html.replace(/\{\{LIQUIDITY\}\}/g, settings?.liquidity || 15000000);
        html = html.replace(/\{\{TOTAL_SEATS\}\}/g, settings?.mining_total_seats || 100000);
        html = html.replace(/\{\{CURRENT_SEATS\}\}/g, settings?.mining_current_seats || 0);
        html = html.replace(/\{\{MINING_OPEN\}\}/g, settings?.mining_open ? 'true' : 'false');
        html = html.replace(/\{\{USDT_WALLET\}\}/g, process.env.USDT_WALLET || '0x2975dc1f8188c30b2a4be0ec27e33494da66cb46');

        res.send(html);
    } catch (error) {
        console.error("❌ خطأ في /app:", error);
        res.status(500).send(`<h1>خطأ داخلي: ${error.message}</h1>`);
    }
});

// ==============================
// 14. المسار الرئيسي
// ==============================
app.get('/', (req, res) => {
    res.send('🚀 مشروع Vortex يعمل بنجاح!');
});

// ==============================
// 15. تشغيل السيرفر
// ==============================
app.listen(PORT, () => {
    console.log(`✅ سيرفر Vortex يعمل على المنفذ ${PORT}`);
});
