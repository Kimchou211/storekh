// ════════════════════════════════════════════════════════════
//  server.js  —  NyKa Shop  Complete Backend  v5.0
//  Supabase · JWT Auth · Bakong KHQR · Telegram · Products DB
// ════════════════════════════════════════════════════════════
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────
// ចំណាំ៖ នៅលើ Cloudflare បើ process.env មិនដើរ ត្រូវប្រាកដថាបាន set ក្នុង Dashboard
const BAKONG = {
  token   : (typeof process !== 'undefined' ? process.env.BAKONG_TOKEN : '') || '',
  account : (typeof process !== 'undefined' ? process.env.BAKONG_ACCOUNT : '') || 'kimchou_kren@bkrt',
  merchant: (typeof process !== 'undefined' ? process.env.BAKONG_MERCHANT : '') || 'NyKa_Shop',
  city    : (typeof process !== 'undefined' ? process.env.BAKONG_CITY : '') || 'Kampong Chhnang',
  country : 'KH',
};
const TG = {
  token  : (typeof process !== 'undefined' ? process.env.TG_TOKEN : '') || '',
  chat_id: (typeof process !== 'undefined' ? process.env.TG_CHAT_ID : '') || '',
  contact: (typeof process !== 'undefined' ? process.env.TG_CONTACT : '') || 'https://t.me/krenkimchou',
};
const JWT_SECRET = (typeof process !== 'undefined' ? process.env.JWT_SECRET : '') || 'nyka_shop_2025_secret';
const PORT       = (typeof process !== 'undefined' ? process.env.PORT : '') || 5000;

// WEBHOOK_URL សម្រាប់ Telegram Callback
const WEBHOOK_URL = (typeof process !== 'undefined' ? process.env.WEBHOOK_URL : '') || '';

// ─── SUPABASE ─────────────────────────────────────────────────
const supabaseUrl = (typeof process !== 'undefined' ? process.env.SUPABASE_URL : '');
const supabaseKey = (typeof process !== 'undefined' ? process.env.SUPABASE_SERVICE_ROLE_KEY : '');

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Warning: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Check your Cloudflare Variables.');
}

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('/{*path}', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── SUPABASE HELPER ──────────────────────────────────────────
// Throws on error so callers can catch uniformly
function must(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

// ─── SEED ADMIN ───────────────────────────────────────────────
async function seedAdmin() {
  try {
    const { data } = await supabase
      .from('users')
      .select('id')
      .eq('email', 'admin@nyka.shop')
      .maybeSingle();
    if (!data) {
      const hash = await bcrypt.hash('admin123', 10);
      await supabase.from('users').insert({
        name: 'Admin NyKa', email: 'admin@nyka.shop',
        password: hash, role: 'admin',
        phone: '', address: '',
      });
      console.log('✅ Admin seeded: admin@nyka.shop / admin123');
    }
  } catch(e) { console.error('⚠️  seedAdmin:', e.message); }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
function auth(req, res, next) {
  const t = req.headers['authorization']?.split(' ')[1];
  if (!t) return res.status(401).json({ success: false, message: 'No token' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(403).json({ success: false, message: 'Invalid token' }); }
}

function adminAuth(req, res, next) {
  const t = req.headers['authorization']?.split(' ')[1];
  if (!t) return res.status(401).json({ success: false, message: 'No token' });
  try {
    const user = jwt.verify(t, JWT_SECRET);
    if (user.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Admin only' });
    req.user = user; next();
  } catch { res.status(403).json({ success: false, message: 'Invalid token' }); }
}

// ─── KHQR BUILDER ─────────────────────────────────────────────
function crc16(s) {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++)
      c = (c & 0x8000) ? ((c<<1)^0x1021)&0xFFFF : (c<<1)&0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4,'0');
}
function tlv(tag, val) { return `${tag}${String(val.length).padStart(2,'0')}${val}`; }
function buildKHQR({ amount, bill, currency = 'USD' }) {
  const isKHR = currency === 'KHR';
  const amt   = isKHR ? String(Math.round(+amount)) : (+amount).toFixed(2);
  const tag29 = tlv('00', BAKONG.account);
  const tag62 = tlv('01', bill.substring(0,20)) + tlv('07','nyka');
  let p = tlv('00','01') + tlv('01','12') + tlv('29',tag29)
        + tlv('52','5999') + tlv('58',BAKONG.country)
        + tlv('59',BAKONG.merchant) + tlv('60',BAKONG.city)
        + tlv('54',amt) + tlv('53', isKHR?'116':'840')
        + tlv('62',tag62) + '6304';
  return p + crc16(p);
}

// ─── TELEGRAM ─────────────────────────────────────────────────
async function tgSend(text, extra = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG.chat_id, text, parse_mode: 'HTML', ...extra }),
    });
    const d = await r.json();
    if (d.ok) console.log('📨 Telegram sent');
    else console.error('❌ Telegram:', d.description);
    return d;
  } catch(e) { console.error('❌ Telegram error:', e.message); return { ok: false }; }
}

async function tgEditMsg(msgId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG.token}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG.chat_id, message_id: msgId, text, parse_mode: 'HTML' }),
    });
  } catch(e) { console.error('❌ Telegram edit error:', e.message); }
}

async function tgAnswer(callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG.token}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch {}
}

async function registerWebhook() {
  const host = WEBHOOK_URL;
  if (!host) { console.log('⚠️  WEBHOOK_URL not set — Telegram inline confirm requires this'); return; }
  const url = host + '/api/telegram/webhook';
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG.token}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    console.log(d.ok ? '✅ Webhook set: ' + url : '❌ Webhook failed: ' + d.description);
  } catch(e) { console.error('❌ Webhook error:', e.message); }
}

function tgMsgText(o) {
  const bar   = '━━━━━━━━━━━━━━━━━━━━━━';
  const items = (o.items||[]).map(i =>
    `  • ${i.icon||''} <b>${i.name}</b>  ×${i.qty||1}  →  <b>$${((+i.price)*(i.qty||1)).toFixed(2)}</b>`
  ).join('\n') || '  (គ្មានទំនិញ)';
  const isPending = o.status === 'pending';
  return `🛍 <b>ការបញ្ជាទិញថ្មី — NyKa Shop</b>
${bar}
📋 <b>Bill:</b> <code>${o.bill}</code>
👤 <b>អតិថិជន:</b> ${o.name||'Guest'}
📧 <b>Email:</b> ${o.email||'—'}
📞 <b>ទូរស័ព្ទ:</b> ${o.phone||'—'}
${bar}
🛒 <b>ទំនិញ:</b>
${items}
${bar}
💰 <b>សរុប: $${(+o.total).toFixed(2)}</b>
💬 <b>បង់ប្រាក់តាម Telegram</b>
🕐 ${new Date().toLocaleString('km-KH')}
${bar}
${isPending
  ? '⚠️ <b>រង់ចាំការបង់ប្រាក់</b>\n📲 ទំនាក់ទំនងអតិថិជន ហើយ confirm ការបង់ប្រាក់'
  : '✅ <b>បានបង់ប្រាក់ — CONFIRMED រួចហើយ</b>'}`;
}

async function tgSendOrder(o) {
  const text  = tgMsgText(o);
  const extra = o.status === 'pending' ? {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Confirm បង់ប្រាក់', callback_data: `confirm:${o.bill}` },
        { text: '❌ Cancel',             callback_data: `cancel:${o.bill}` },
      ]],
    },
  } : {};
  return tgSend(text, extra);
}

// ─── INVOICE HTML ─────────────────────────────────────────────
function invoice(o) {
  const rows = (o.items||[]).map(i=>`
    <tr>
      <td>${i.icon||''} ${i.name}</td>
      <td style="text-align:center;font-family:monospace">${i.qty||1}</td>
      <td style="text-align:right;font-family:monospace">$${(+i.price).toFixed(2)}</td>
      <td style="text-align:right;font-family:monospace"><b>$${((+i.price)*(i.qty||1)).toFixed(2)}</b></td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="km">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${o.bill}</title>
<link href="https://fonts.googleapis.com/css2?family=Kantumruy+Pro:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
@media print{.noprint{display:none!important}body{background:#fff}.wrap{box-shadow:none}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f5f0ec;font-family:'Kantumruy Pro',sans-serif;color:#1a0a0f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{background:#fff;border-radius:20px;max-width:560px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(180,80,100,.15)}
.top{background:linear-gradient(135deg,#e11d48,#fb7185);padding:28px 32px;color:#fff}
.logo{font-size:1.4rem;font-weight:700;letter-spacing:-.02em}
.logo-sub{font-size:.7rem;opacity:.75;margin-top:2px;font-family:'JetBrains Mono',monospace;letter-spacing:.1em}
.paid-pill{display:inline-flex;align-items:center;gap:6px;margin-top:14px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);border-radius:100px;padding:5px 14px;font-size:.72rem;font-family:'JetBrains Mono',monospace}
.body{padding:28px 32px}
.metas{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:22px}
.meta{background:#fff5f7;border:1px solid #fce7ef;border-radius:10px;padding:12px}
.ml{font-size:.58rem;color:#b89ca2;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.mv{font-size:.8rem;font-weight:600;color:#e11d48;word-break:break-all}
.mv.dark{color:#1a0a0f}
table{width:100%;border-collapse:collapse;margin-bottom:16px}
th{font-size:.6rem;color:#b89ca2;font-family:'JetBrains Mono',monospace;text-align:left;padding:6px 0;border-bottom:1px solid #f0e8e8;letter-spacing:.06em}
td{padding:10px 0;border-bottom:1px solid #fce7ef;font-size:.82rem}
.totbox{background:linear-gradient(135deg,#fff1f5,#fce7f3);border:1px solid #fecdd3;border-radius:12px;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.tl{font-size:.85rem;font-weight:600;color:#7c5c65}
.tv{font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:700;color:#e11d48}
.printbtn{display:block;width:100%;padding:13px;border:none;border-radius:10px;background:linear-gradient(135deg,#e11d48,#fb7185);color:#fff;font-family:'Kantumruy Pro',sans-serif;font-weight:700;font-size:.9rem;cursor:pointer}
.foot{background:#fff5f7;border-top:1px solid #fce7ef;padding:16px 32px;text-align:center;font-size:.72rem;color:#b89ca2;line-height:1.9}
.foot a{color:#e11d48;text-decoration:none;font-weight:600}
</style></head><body>
<div class="wrap">
  <div class="top">
    <div class="logo">🌸 NyKa Shop</div>
    <div class="logo-sub">វិក្កយបត្រ / Official Invoice</div>
    <div class="paid-pill">✅ Telegram Payment — បានបង់ប្រាក់</div>
  </div>
  <div class="body">
    <div class="metas">
      <div class="meta"><div class="ml">លេខវិក្កយបត្រ</div><div class="mv">${o.bill}</div></div>
      <div class="meta"><div class="ml">ថ្ងៃម៉ោង</div><div class="mv" style="font-size:.65rem;color:#7c5c65">${new Date().toLocaleString('km-KH')}</div></div>
      <div class="meta"><div class="ml">អតិថិជន</div><div class="mv dark">${o.name||'Guest'}</div></div>
      <div class="meta"><div class="ml">Email</div><div class="mv" style="font-size:.65rem;color:#7c5c65">${o.email||'—'}</div></div>
    </div>
    <table>
      <thead><tr><th>ទំនិញ</th><th style="text-align:center">ចំ.</th><th style="text-align:right">តម្លៃ</th><th style="text-align:right">សរុប</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totbox"><span class="tl">💰 សរុបទឹកប្រាក់</span><span class="tv">$${(+o.total).toFixed(2)}</span></div>
    <button class="printbtn noprint" onclick="window.print()">🖨️ Print / Save PDF</button>
  </div>
  <div class="foot">
    🎉 សូមអរគុណ! NyKa Shop ដឹងគុណចំពោះការទុកចិត្ត<br>
    <a href="${TG.contact}" target="_blank">✈️ Telegram Admin</a><br>
    📍 ភ្នំពេញ, កម្ពុជា
  </div>
</div></body></html>`;
}

// ─── IN-MEMORY STORE (active payment sessions) ─────────────────
// Keeps tgMsgId & quick status without extra DB round-trip
const store = {};

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// Health check
app.get('/api/test', (_, res) =>
  res.json({ ok: true, db: 'supabase', bakong: BAKONG.account, time: new Date().toISOString() })
);

// ══════════════════════════════════════════
//  PRODUCTS — PUBLIC
// ══════════════════════════════════════════

app.get('/api/products', async (req, res) => {
  try {
    const { category, search } = req.query;
    let q = supabase
      .from('products')
      .select('id,name,brand,description,price,old_price,icon,category,badge,specs,images,rating,reviews,stock,created_at')
      .eq('active', true)
      .order('id', { ascending: false });
    if (category && category !== 'all') q = q.eq('category', category);
    if (search) q = q.or(`name.ilike.%${search}%,brand.ilike.%${search}%,description.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, products: data || [] });
  } catch(e) { console.error(e); res.json({ success: true, products: [] }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .eq('active', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, product: data });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
//  PRODUCTS — ADMIN
// ══════════════════════════════════════════

app.post('/api/products', adminAuth, async (req, res) => {
  try {
    const {
      name, brand='', description='', price, old_price=null,
      icon='🌸', category='', badge='', specs=[], images=[],
      rating=4.5, reviews=0, stock=100,
    } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'name & price required' });
    const { data, error } = await supabase.from('products').insert({
      name, brand, description, price: +price, old_price: old_price||null,
      icon, category, badge, specs, images,
      rating: +rating||4.5, reviews: +reviews||0, stock: +stock||100, active: true,
    }).select('id').single();
    if (error) throw error;
    console.log(`✅ Product created: ${name} (id=${data.id})`);
    res.status(201).json({ success: true, id: data.id, message: 'Product created' });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/products/:id', adminAuth, async (req, res) => {
  try {
    const {
      name, brand='', description='', price, old_price=null,
      icon='🌸', category='', badge='', specs=[], images=[],
      rating=4.5, stock=100, active,
    } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'name & price required' });
    const update = {
      name, brand, description, price: +price, old_price: old_price||null,
      icon, category, badge, specs, images,
      rating: +rating||4.5, stock: +stock||100, updated_at: new Date().toISOString(),
    };
    if (active !== undefined) update.active = Boolean(active);
    const { error } = await supabase.from('products').update(update).eq('id', req.params.id);
    if (error) throw error;
    console.log(`✅ Product updated: id=${req.params.id}`);
    res.json({ success: true, message: 'Product updated' });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/products/:id', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('products').update({ active: false }).eq('id', req.params.id);
    if (error) throw error;
    console.log(`🗑️ Product soft-deleted: id=${req.params.id}`);
    res.json({ success: true, message: 'Product deleted' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone='', address='', password } = req.body;
    if (!name||!email||!password)
      return res.status(400).json({ success: false, message: 'សូមបំពេញ ឈ្មោះ, អ៊ីមែល, លេខសំងាត់' });
    if (password.length < 6)
      return res.status(400).json({ success: false, message: 'លេខសំងាត់ minimum ៦ characters' });

    // Check duplicate
    const { data: ex } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (ex) return res.status(400).json({ success: false, message: 'អ៊ីមែលនេះបានចុះឈ្មោះរួចហើយ' });

    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('users')
      .insert({ name, email, phone, address, password: hash, role: 'user' })
      .select('id').single();
    if (error) throw error;

    const token = jwt.sign({ id: data.id, email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      success: true, message: 'ចុះឈ្មោះជោគជ័យ',
      user: { id: data.id, name, email, phone, address, role: 'user' }, token,
    });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password)
      return res.status(400).json({ success: false, message: 'សូមបំពេញ អ៊ីមែល និង លេខសំងាត់' });
    const { data: u, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (error) throw error;
    if (!u || !(await bcrypt.compare(password, u.password)))
      return res.status(400).json({ success: false, message: 'អ៊ីមែល ឬ លេខសំងាត់មិនត្រូវ' });
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
    delete u.password;
    res.json({ success: true, message: 'ចូលគណនីជោគជ័យ', user: u, token });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/user', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id,name,email,phone,address,role,created_at')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false });
    res.json({ success: true, user: data });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/user/update', auth, async (req, res) => {
  try {
    const { name, phone, address, password } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });
    const update = { name, phone: phone||'', address: address||'', updated_at: new Date().toISOString() };
    if (password) update.password = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').update(update).eq('id', req.user.id);
    if (error) throw error;
    const { data } = await supabase
      .from('users').select('id,name,email,phone,address,role,created_at').eq('id', req.user.id).single();
    res.json({ success: true, user: data });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════
//  CHECKOUT & PAYMENT
// ══════════════════════════════════════════

app.post('/api/bakong/checkout', async (req, res) => {
  try {
    const { amount, currency='USD', orderId, userId, userName, userEmail, userPhone='', items=[], notes='' } = req.body;
    if (!amount || isNaN(amount) || +amount <= 0)
      return res.status(400).json({ success: false, message: 'Invalid amount' });

    const bill = (orderId || ('INV-'+Date.now())).substring(0,25);

    // Insert order into Supabase
    const { data: orderRow, error: orderErr } = await supabase.from('orders').insert({
      order_number   : bill,
      user_id        : userId || null,
      user_name      : userName  || '',
      user_email     : userEmail || '',
      user_phone     : userPhone || '',
      total_amount   : +amount,
      currency       : 'USD',
      status         : 'pending',
      payment_method : 'telegram',
      bill_number    : bill,
      notes          : notes || '',
    }).select('id').single();
    if (orderErr) throw orderErr;
    const dbId = orderRow.id;

    // Insert order items
    if (items.length) {
      const itemRows = items.map(it => {
        const qty = +it.qty || +it.quantity || 1;
        return {
          order_id    : dbId,
          product_id  : it.id || it.product_id || null,
          product_name: it.name  || '',
          product_icon: it.icon  || '',
          price       : +it.price || 0,
          quantity    : qty,
          subtotal    : (+it.price||0) * qty,
        };
      });
      const { error: itemErr } = await supabase.from('order_items').insert(itemRows);
      if (itemErr) console.error('order_items insert error:', itemErr.message);
    }

    // Payment log
    await supabase.from('payment_logs').insert({
      bill_number: bill, order_id: dbId,
      action: 'checkout', bakong_message: 'Telegram payment order created',
    });

    // Cache in memory for quick status check
    store[bill] = {
      status: 'pending', amount: +amount, currency, dbId,
      userId, userName, userEmail, userPhone,
      items: items.map(i => ({ ...i, qty: +i.qty||+i.quantity||1 })),
      created: new Date().toISOString(),
    };

    // Send Telegram notification + inline Confirm button
    const tgRes = await tgSendOrder({
      bill, name: userName, email: userEmail, phone: userPhone,
      total: +amount, items: store[bill].items, status: 'pending',
    });
    if (tgRes.ok && tgRes.result) store[bill].tgMsgId = tgRes.result.message_id;

    await supabase.from('orders')
      .update({ telegram_sent: tgRes.ok })
      .eq('id', dbId);

    console.log(`💬 Telegram checkout: ${bill} | ${currency} ${amount}`);
    res.json({
      success: true, billNumber: bill, amount: +amount, currency,
      telegramContact: TG.contact,
      message: 'ការបញ្ជាទិញបានទទួលហើយ! Admin នឹងទំនាក់ទំនងតាម Telegram។',
    });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/bakong/status/:bill', async (req, res) => {
  const { bill } = req.params;

  // Try memory first for speed
  if (store[bill]) {
    return res.json({
      status: store[bill].status,
      billNumber: bill,
      amount: store[bill].amount,
      currency: store[bill].currency,
      telegramContact: TG.contact,
    });
  }

  // Fallback to Supabase
  try {
    const { data } = await supabase.from('orders').select('status,total_amount,currency').eq('bill_number', bill).maybeSingle();
    if (!data) return res.json({ status: 'not_found' });
    return res.json({ status: data.status, billNumber: bill, amount: data.total_amount, currency: data.currency, telegramContact: TG.contact });
  } catch { return res.json({ status: 'not_found' }); }
});

// ─── CONFIRM ORDER (shared by webhook + manual) ───────────────
async function confirmOrder(bill, host) {
  if (!store[bill] || store[bill].status === 'paid') {
    // also check DB in case store was lost (restart)
    const { data } = await supabase.from('orders').select('id,status').eq('bill_number', bill).maybeSingle();
    if (!data || data.status === 'paid') return false;
    if (!store[bill]) store[bill] = { tgMsgId: null };
  }

  store[bill].status = 'paid';
  store[bill].paidAt = new Date().toISOString();
  const inf = store[bill];

  await supabase.from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('bill_number', bill);

  await supabase.from('payment_logs').insert({
    bill_number: bill, order_id: inf.dbId || null,
    action: 'manual_confirm', bakong_message: 'Admin confirmed via Telegram',
  });

  if (inf.tgMsgId) {
    await tgEditMsg(inf.tgMsgId, tgMsgText({
      bill, name: inf.userName, email: inf.userEmail,
      phone: inf.userPhone, total: inf.amount,
      items: inf.items, status: 'paid',
    }));
  }

  const invoiceUrl = host ? `${host}/api/invoice/${bill}` : `/api/invoice/${bill}`;
  await tgSend(`✅ <b>Order Confirmed!</b>\n📋 Bill: <code>${bill}</code>\n\n🧾 <a href="${invoiceUrl}">ចុចទីនេះដើម្បីមើល Invoice</a>`);
  return true;
}

// Telegram Webhook — inline button callbacks
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  const cb   = req.body.callback_query;
  if (!cb) return;
  const { id: cbId, data } = cb;
  const host = WEBHOOK_URL;

  if (data && data.startsWith('confirm:')) {
    const bill = data.replace('confirm:', '');
    const ok   = await confirmOrder(bill, host);
    await tgAnswer(cbId, ok ? '✅ Confirmed!' : '⚠️ រួចហើយ ឬ រកមិនឃើញ');
  } else if (data && data.startsWith('cancel:')) {
    const bill = data.replace('cancel:', '');
    await supabase.from('orders').update({ status: 'cancelled' }).eq('bill_number', bill);
    if (store[bill]) store[bill].status = 'cancelled';
    await tgAnswer(cbId, '❌ Cancelled');
    if (store[bill]?.tgMsgId)
      await tgEditMsg(store[bill].tgMsgId, `❌ <b>Order Cancelled</b>\n📋 Bill: <code>${bill}</code>`);
  }
});

// Admin manual confirm (fallback)
app.post('/api/bakong/confirm/:bill', async (req, res) => {
  const { bill } = req.params;
  const host = `${req.protocol}://${req.get('host')}`;
  const ok = await confirmOrder(bill, host);
  if (!ok) return res.status(404).json({ success: false, message: 'Not found or already confirmed' });
  res.json({ success: true, bill });
});

// Invoice page
app.get('/api/invoice/:bill', async (req, res) => {
  const { bill } = req.params;

  let inf = store[bill];
  if (!inf || inf.status !== 'paid') {
    // Try DB
    try {
      const { data: ord } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .eq('bill_number', bill)
        .eq('status', 'paid')
        .maybeSingle();
      if (!ord) return res.status(404).send(`<html><body style="background:#fff5f7;color:#e11d48;display:flex;height:100vh;align-items:center;justify-content:center;font-family:sans-serif;text-align:center"><div><h2>Invoice រកមិនឃើញ</h2><p style="color:#b89ca2;margin-top:8px">${bill}</p></div></body></html>`);
      inf = {
        userName: ord.user_name, userEmail: ord.user_email,
        amount: ord.total_amount,
        items: (ord.order_items||[]).map(i => ({ icon: i.product_icon, name: i.product_name, price: i.price, qty: i.quantity })),
      };
    } catch {
      return res.status(404).send('Invoice not found');
    }
  }

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(invoice({ bill, name: inf.userName, email: inf.userEmail, total: inf.amount, items: inf.items }));
});

// ══════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════

// User's own orders
app.get('/api/orders', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id,order_number,user_name,user_email,total_amount,currency,status,delivery_status,bill_number,paid_at,created_at,order_items(product_icon,product_name,price,quantity,subtotal)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const orders = (data||[]).map(o => ({
      ...o,
      items: (o.order_items||[]).map(i => ({
        icon: i.product_icon, name: i.product_name,
        price: i.price, qty: i.quantity, subtotal: i.subtotal,
      })),
    }));
    res.json({ success: true, orders });
  } catch(e) { console.error(e); res.json({ success: true, orders: [] }); }
});

// ══════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

    const { data: u, error } = await supabase.from('users')
      .select('*')
      .eq('email', email)
      .eq('role', 'admin')
      .maybeSingle();

    if (error) {
      console.error('Supabase Login Error:', error.message);
      return res.status(500).json({ success: false, message: 'Database error: ' + error.message });
    }

    if (!u || !(await bcrypt.compare(password, u.password)))
      return res.status(400).json({ success: false, message: 'Admin credentials incorrect' });

    const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, message: 'Admin login success', user: { id: u.id, name: u.name, email: u.email, role: u.role }, token });
  } catch(e) { 
    console.error('Admin Login Crash:', e);
    res.status(500).json({ success: false, message: 'Server crash: ' + e.message }); 
  }
});

// All orders (admin)
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    let q = supabase
      .from('orders')
      .select('id,order_number,user_id,user_name,user_email,user_phone,total_amount,currency,status,delivery_status,payment_method,bill_number,telegram_sent,notes,paid_at,created_at,order_items(product_icon,product_name,price,quantity,subtotal)')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (search) q = q.or(`user_name.ilike.%${search}%,user_email.ilike.%${search}%,order_number.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    const orders = (data||[]).map(o => ({
      ...o,
      items: (o.order_items||[]).map(i => ({
        icon: i.product_icon, name: i.product_name,
        price: i.price, qty: i.quantity, subtotal: i.subtotal,
      })),
    }));
    res.json({ success: true, orders });
  } catch(e) { console.error(e); res.json({ success: true, orders: [] }); }
});

// Update order status
app.put('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
  try {
    const { status, delivery_status, notes } = req.body;
    const allowed = ['pending','paid','cancelled','refunded','delivered'];
    const update  = { updated_at: new Date().toISOString() };
    if (status && allowed.includes(status)) update.status = status;
    if (delivery_status) update.delivery_status = delivery_status;
    if (notes !== undefined) update.notes = notes;
    const { error } = await supabase.from('orders').update(update).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// All users
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id,name,email,phone,address,role,created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, users: data || [] });
  } catch(e) { res.json({ success: true, users: [] }); }
});

// Dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [
      { count: total_orders },
      { count: paid_orders },
      { count: pending_orders },
      { count: total_users },
      { count: total_products },
      { data: revenueData },
      { data: todayData },
    ] = await Promise.all([
      supabase.from('orders').select('*', { count: 'exact', head: true }),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'paid'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('users').select('*',  { count: 'exact', head: true }),
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('orders').select('total_amount').eq('status', 'paid'),
      supabase.from('orders').select('total_amount').eq('status', 'paid')
        .gte('paid_at', new Date().toISOString().slice(0,10)),
    ]);
    const total_revenue = (revenueData||[]).reduce((s,o) => s + (+o.total_amount||0), 0);
    const today_revenue = (todayData||[]).reduce((s,o)   => s + (+o.total_amount||0), 0);
    res.json({ success: true, stats: {
      total_orders, paid_orders, pending_orders,
      total_users, total_products, total_revenue, today_revenue,
    }});
  } catch(e) { console.error(e); res.json({ success: true, stats: {} }); }
});

// Revenue chart (last 7 days)
app.get('/api/admin/revenue-chart', adminAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7*24*3600*1000).toISOString();
    const { data, error } = await supabase
      .from('orders')
      .select('paid_at,total_amount')
      .eq('status', 'paid')
      .gte('paid_at', since);
    if (error) throw error;
    // Group by date in JS
    const map = {};
    for (const o of data||[]) {
      const d = o.paid_at.slice(0,10);
      if (!map[d]) map[d] = { date: d, revenue: 0, count: 0 };
      map[d].revenue += +o.total_amount;
      map[d].count++;
    }
    res.json({ success: true, data: Object.values(map).sort((a,b) => a.date.localeCompare(b.date)) });
  } catch(e) { res.json({ success: true, data: [] }); }
});

// Admin: all products (incl. inactive)
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id,name,brand,price,old_price,icon,category,badge,specs,images,rating,reviews,stock,active,created_at')
      .order('id', { ascending: false });
    if (error) throw error;
    res.json({ success: true, products: data || [] });
  } catch(e) { res.json({ success: true, products: [] }); }
});

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const {
      name, brand='', description='', price, old_price=null,
      icon='🌸', category='', badge='', specs=[], images=[],
      rating=4.5, reviews=0, stock=100,
    } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'name & price required' });
    const { data, error } = await supabase.from('products').insert({
      name, brand, description, price: +price, old_price: old_price||null,
      icon, category, badge, specs, images,
      rating: +rating||4.5, reviews: +reviews||0, stock: +stock||100, active: true,
    }).select('id').single();
    if (error) throw error;
    console.log(`✅ [Admin] Product created: ${name} (id=${data.id})`);
    res.status(201).json({ success: true, id: data.id, message: 'Product created' });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const {
      name, brand='', description='', price, old_price=null,
      icon='🌸', category='', badge='', specs=[], images=[],
      rating=4.5, stock=100, active,
    } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'name & price required' });
    const update = {
      name, brand, description, price: +price, old_price: old_price||null,
      icon, category, badge, specs, images,
      rating: +rating||4.5, stock: +stock||100, updated_at: new Date().toISOString(),
    };
    if (active !== undefined) update.active = Boolean(active);
    const { error } = await supabase.from('products').update(update).eq('id', req.params.id);
    if (error) throw error;
    console.log(`✅ [Admin] Product updated: id=${req.params.id}`);
    res.json({ success: true, message: 'Product updated' });
  } catch(e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('products').update({ active: false }).eq('id', req.params.id);
    if (error) throw error;
    console.log(`🗑️ [Admin] Product deleted: id=${req.params.id}`);
    res.json({ success: true, message: 'Product deleted' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Serve static files
app.use(express.static('.'));

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════
async function start() {
  await seedAdmin();
  await registerWebhook();

  // app.listen ដំណើរការតែលើ Local Node.js ប៉ុណ្ណោះ
  if (typeof process !== 'undefined' && process.release && process.release.name === 'node') {
    app.listen(PORT, () => {
      console.log('\n╔══════════════════════════════════════════════╗');
      console.log(`║  🌸  NyKa Shop  Server  →  port ${PORT}           ║`);
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║  🗄️   Database : Supabase (PostgreSQL)         ║`);
      console.log(`║  💳  Bakong   : ${BAKONG.account}   ║`);
      console.log(`║  🔐  Admin    : admin@nyka.shop / admin123    ║`);
      console.log(`║  📡  Health   : http://localhost:${PORT}/api/test  ║`);
      console.log('╚══════════════════════════════════════════════╝\n');
    });
  }
}

start().catch(console.error);

// Export សម្រាប់ Cloudflare Workers
export default app;
