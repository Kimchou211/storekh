// ════════════════════════════════════════════════════════════
//  server.js  —  NyKa Shop  Complete Backend  v5.1
//  Cloudflare Workers compatible (env binding instead of process.env)
//  Supabase · JWT Auth · Bakong KHQR · Telegram · Products DB
// ════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';

// ─── Helper: get env from Workers binding or process.env ──────
function getEnv(envObj, key) {
  // Cloudflare Workers passes env as argument; fallback to process.env for local dev
  if (envObj && envObj[key]) return envObj[key];
  if (typeof process !== 'undefined' && process.env && process.env[key]) return process.env[key];
  return '';
}

// ─── CORS HEADERS ─────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS,PATCH',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function json(data, status = 200) {
  return corsResponse(JSON.stringify(data), status);
}

// ─── KHQR BUILDER ─────────────────────────────────────────────
function crc16(s) {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++)
      c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function tlv(tag, val) { return `${tag}${String(val.length).padStart(2, '0')}${val}`; }

// ─── MAIN WORKER HANDLER ──────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // ── Preflight ────────────────────────────────────────────
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Config from env ──────────────────────────────────────
    const SUPABASE_URL            = getEnv(env, 'SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const JWT_SECRET              = getEnv(env, 'JWT_SECRET') || 'nyka_shop_2025_secret';
    const TG_TOKEN                = getEnv(env, 'TG_TOKEN');
    const TG_CHAT_ID              = getEnv(env, 'TG_CHAT_ID');
    const TG_CONTACT              = getEnv(env, 'TG_CONTACT') || 'https://t.me/krenkimchou';
    const WEBHOOK_URL             = getEnv(env, 'WEBHOOK_URL') || '';
    const BAKONG_ACCOUNT          = getEnv(env, 'BAKONG_ACCOUNT') || 'kimchou_kren@bkrt';
    const BAKONG_MERCHANT         = getEnv(env, 'BAKONG_MERCHANT') || 'NyKa_Shop';
    const BAKONG_CITY             = getEnv(env, 'BAKONG_CITY') || 'Kampong Chhnang';

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ success: false, message: 'Server misconfigured: Supabase env vars missing' }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Helpers ──────────────────────────────────────────────
    function must(result) {
      if (result.error) throw new Error(result.error.message);
      return result.data;
    }

    function buildKHQR({ amount, bill, currency = 'USD' }) {
      const isKHR = currency === 'KHR';
      const amt = isKHR ? String(Math.round(+amount)) : (+amount).toFixed(2);
      const tag29 = tlv('00', BAKONG_ACCOUNT);
      const tag62 = tlv('01', bill.substring(0, 20)) + tlv('07', 'nyka');
      let p = tlv('00', '01') + tlv('01', '12') + tlv('29', tag29)
        + tlv('52', '5999') + tlv('58', 'KH')
        + tlv('59', BAKONG_MERCHANT) + tlv('60', BAKONG_CITY)
        + tlv('54', amt) + tlv('53', isKHR ? '116' : '840')
        + tlv('62', tag62) + '6304';
      return p + crc16(p);
    }

    async function tgSend(text, extra = {}) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', ...extra }),
        });
        return await r.json();
      } catch (e) { return { ok: false }; }
    }

    async function tgEditMsg(msgId, text) {
      try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, message_id: msgId, text, parse_mode: 'HTML' }),
        });
      } catch { }
    }

    function verifyAuth(request) {
      const t = request.headers.get('authorization')?.split(' ')[1];
      if (!t) return null;
      try { return jwt.verify(t, JWT_SECRET); }
      catch { return null; }
    }

    function requireAuth(request) {
      const user = verifyAuth(request);
      if (!user) throw { status: 401, message: 'No token' };
      return user;
    }

    function requireAdmin(request) {
      const user = verifyAuth(request);
      if (!user) throw { status: 401, message: 'No token' };
      if (user.role !== 'admin') throw { status: 403, message: 'Admin only' };
      return user;
    }

    // ── Parse body ───────────────────────────────────────────
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try { body = await request.json(); } catch { body = {}; }
    }

    // ════════════════════════════════════════════════════════
    //  ROUTES
    // ════════════════════════════════════════════════════════

    try {

      // ── Health ──────────────────────────────────────────
      if (path === '/api/test' && method === 'GET') {
        return json({ success: true, message: '🌸 NyKa Shop API v5.1 — Cloudflare Workers', ts: new Date().toISOString() });
      }

      // ── Auth: Register ──────────────────────────────────
      if (path === '/api/auth/register' && method === 'POST') {
        const { name, email, password, phone = '', address = '' } = body;
        if (!name || !email || !password)
          return json({ success: false, message: 'name, email, password required' }, 400);
        const { data: ex } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
        if (ex) return json({ success: false, message: 'Email already registered' }, 409);
        const hash = await bcrypt.hash(password, 10);
        const { data: u, error } = await supabase.from('users')
          .insert({ name, email, password: hash, role: 'user', phone, address })
          .select('id,name,email,role').single();
        if (error) throw error;
        const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '30d' });
        return json({ success: true, token, user: u }, 201);
      }

      // ── Auth: Login ─────────────────────────────────────
      if (path === '/api/auth/login' && method === 'POST') {
        const { email, password } = body;
        if (!email || !password)
          return json({ success: false, message: 'email & password required' }, 400);
        const { data: u } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
        if (!u) return json({ success: false, message: 'Invalid credentials' }, 401);
        const ok = await bcrypt.compare(password, u.password);
        if (!ok) return json({ success: false, message: 'Invalid credentials' }, 401);
        const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '30d' });
        return json({ success: true, token, user: { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone, address: u.address } });
      }

      // ── Auth: Profile ────────────────────────────────────
      if (path === '/api/auth/profile' && method === 'GET') {
        const user = requireAuth(request);
        const { data: u, error } = await supabase.from('users').select('id,name,email,phone,address,role,created_at').eq('id', user.id).single();
        if (error) throw error;
        return json({ success: true, user: u });
      }

      if (path === '/api/auth/profile' && method === 'PUT') {
        const user = requireAuth(request);
        const { name, phone, address } = body;
        const { error } = await supabase.from('users').update({ name, phone, address, updated_at: new Date().toISOString() }).eq('id', user.id);
        if (error) throw error;
        return json({ success: true, message: 'Profile updated' });
      }

      // ── Products ─────────────────────────────────────────
      if (path === '/api/products' && method === 'GET') {
        const category = url.searchParams.get('category');
        const search   = url.searchParams.get('search');
        let q = supabase.from('products').select('id,name,brand,price,old_price,icon,category,badge,specs,images,rating,reviews,stock').eq('active', true).order('id', { ascending: false });
        if (category && category !== 'all') q = q.eq('category', category);
        if (search) q = q.or(`name.ilike.%${search}%,brand.ilike.%${search}%,category.ilike.%${search}%`);
        const { data, error } = await q;
        if (error) throw error;
        return json({ success: true, products: data || [] });
      }

      if (path.match(/^\/api\/products\/\d+$/) && method === 'GET') {
        const id = path.split('/').pop();
        const { data, error } = await supabase.from('products').select('*').eq('id', id).eq('active', true).single();
        if (error || !data) return json({ success: false, message: 'Product not found' }, 404);
        return json({ success: true, product: data });
      }

      // ── KHQR ─────────────────────────────────────────────
      if (path === '/api/khqr/generate' && method === 'POST') {
        const { amount, bill = 'NYKA', currency = 'USD' } = body;
        if (!amount || isNaN(+amount) || +amount <= 0)
          return json({ success: false, message: 'Invalid amount' }, 400);
        const qrStr = buildKHQR({ amount, bill, currency });
        const qrDataUrl = await QRCode.toDataURL(qrStr, { width: 300, margin: 1 });
        return json({ success: true, qr: qrDataUrl, khqr: qrStr, amount: +amount, currency, bill });
      }

      // ── Orders ───────────────────────────────────────────
      if (path === '/api/orders' && method === 'POST') {
        const user = requireAuth(request);
        const { items = [], total, currency = 'USD', payment_method = 'khqr', notes = '' } = body;
        if (!items.length || !total) return json({ success: false, message: 'items & total required' }, 400);
        const bill = 'NK' + Date.now().toString(36).toUpperCase();
        const { data: ud } = await supabase.from('users').select('name,email,phone').eq('id', user.id).single();
        const { data: order, error: oe } = await supabase.from('orders').insert({
          order_number: bill, user_id: user.id,
          user_name: ud?.name || '', user_email: ud?.email || '', user_phone: ud?.phone || '',
          total_amount: +total, currency, status: 'pending', delivery_status: 'processing',
          payment_method, bill_number: bill, notes,
        }).select('id').single();
        if (oe) throw oe;
        const orderItems = items.map(i => ({
          order_id: order.id, product_id: i.id || null,
          product_icon: i.icon || '🌸', product_name: i.name,
          price: +i.price, quantity: +i.qty || 1, subtotal: +i.price * (+i.qty || 1),
        }));
        const { error: ie } = await supabase.from('order_items').insert(orderItems);
        if (ie) throw ie;
        const qrStr = buildKHQR({ amount: total, bill, currency });
        const qrDataUrl = await QRCode.toDataURL(qrStr, { width: 300, margin: 1 }).catch(() => '');
        // Telegram
        const tgBody = { bill, name: ud?.name, email: ud?.email, phone: ud?.phone, items, total, status: 'pending' };
        const tgRes = await tgSend(
          `🛍 <b>ការបញ្ជាទិញថ្មី — NyKa Shop</b>\n📋 Bill: <code>${bill}</code>\n👤 ${ud?.name || 'Guest'}\n💰 $${(+total).toFixed(2)}\n⚠️ រង់ចាំការបង់ប្រាក់`,
          payment_method === 'telegram'
            ? { reply_markup: { inline_keyboard: [[{ text: '✅ Confirm ចំណាយ', callback_data: `confirm_${order.id}` }, { text: '❌ Cancel', callback_data: `cancel_${order.id}` }]] } }
            : {}
        );
        if (tgRes?.result?.message_id) {
          await supabase.from('orders').update({ telegram_sent: true, telegram_msg_id: tgRes.result.message_id }).eq('id', order.id);
        }
        return json({ success: true, order_id: order.id, bill, qr: qrDataUrl, khqr: qrStr }, 201);
      }

      if (path === '/api/orders' && method === 'GET') {
        const user = requireAuth(request);
        const { data, error } = await supabase
          .from('orders')
          .select('id,order_number,total_amount,currency,status,delivery_status,payment_method,created_at,order_items(product_icon,product_name,price,quantity,subtotal)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
        if (error) throw error;
        const orders = (data || []).map(o => ({
          ...o, items: (o.order_items || []).map(i => ({ icon: i.product_icon, name: i.product_name, price: i.price, qty: i.quantity, subtotal: i.subtotal }))
        }));
        return json({ success: true, orders });
      }

      // ── Telegram Webhook ─────────────────────────────────
      if (path === '/api/telegram/webhook' && method === 'POST') {
        const { callback_query } = body;
        if (callback_query) {
          const { id: cbId, data: cbData, message } = callback_query;
          const [action, orderId] = (cbData || '').split('_');
          if (action === 'confirm' || action === 'cancel') {
            const newStatus = action === 'confirm' ? 'paid' : 'cancelled';
            await supabase.from('orders').update({ status: newStatus, paid_at: action === 'confirm' ? new Date().toISOString() : null }).eq('id', orderId);
            const txt = action === 'confirm'
              ? `✅ Order #${orderId} CONFIRMED — ការបង់ប្រាក់ត្រូវបានបញ្ជាក់`
              : `❌ Order #${orderId} CANCELLED`;
            if (message?.message_id) await tgEditMsg(message.message_id, txt);
          }
        }
        return json({ ok: true });
      }

      // ── Admin: Stats ──────────────────────────────────────
      if (path === '/api/admin/stats' && method === 'GET') {
        requireAdmin(request);
        const [
          { count: total_orders }, { count: paid_orders }, { count: pending_orders },
          { count: total_users }, { count: total_products },
          { data: revenueData }, { data: todayData },
        ] = await Promise.all([
          supabase.from('orders').select('*', { count: 'exact', head: true }),
          supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'paid'),
          supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
          supabase.from('users').select('*', { count: 'exact', head: true }),
          supabase.from('products').select('*', { count: 'exact', head: true }).eq('active', true),
          supabase.from('orders').select('total_amount').eq('status', 'paid'),
          supabase.from('orders').select('total_amount').eq('status', 'paid').gte('paid_at', new Date().toISOString().slice(0, 10)),
        ]);
        const total_revenue = (revenueData || []).reduce((s, o) => s + (+o.total_amount || 0), 0);
        const today_revenue = (todayData || []).reduce((s, o) => s + (+o.total_amount || 0), 0);
        return json({ success: true, stats: { total_orders, paid_orders, pending_orders, total_users, total_products, total_revenue, today_revenue } });
      }

      // ── Admin: Revenue chart ──────────────────────────────
      if (path === '/api/admin/revenue-chart' && method === 'GET') {
        requireAdmin(request);
        const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        const { data, error } = await supabase.from('orders').select('paid_at,total_amount').eq('status', 'paid').gte('paid_at', since);
        if (error) throw error;
        const map = {};
        for (const o of data || []) {
          const d = o.paid_at.slice(0, 10);
          if (!map[d]) map[d] = { date: d, revenue: 0, count: 0 };
          map[d].revenue += +o.total_amount; map[d].count++;
        }
        return json({ success: true, data: Object.values(map).sort((a, b) => a.date.localeCompare(b.date)) });
      }

      // ── Admin: Orders ─────────────────────────────────────
      if (path === '/api/admin/orders' && method === 'GET') {
        requireAdmin(request);
        const status = url.searchParams.get('status');
        const search = url.searchParams.get('search');
        let q = supabase.from('orders')
          .select('id,order_number,user_id,user_name,user_email,user_phone,total_amount,currency,status,delivery_status,payment_method,bill_number,telegram_sent,notes,paid_at,created_at,order_items(product_icon,product_name,price,quantity,subtotal)')
          .order('created_at', { ascending: false });
        if (status) q = q.eq('status', status);
        if (search) q = q.or(`user_name.ilike.%${search}%,user_email.ilike.%${search}%,order_number.ilike.%${search}%`);
        const { data, error } = await q;
        if (error) throw error;
        const orders = (data || []).map(o => ({
          ...o, items: (o.order_items || []).map(i => ({ icon: i.product_icon, name: i.product_name, price: i.price, qty: i.quantity, subtotal: i.subtotal }))
        }));
        return json({ success: true, orders });
      }

      if (path.match(/^\/api\/admin\/orders\/[^/]+\/status$/) && method === 'PUT') {
        requireAdmin(request);
        const id = path.split('/')[4];
        const { status, delivery_status, notes } = body;
        const allowed = ['pending', 'paid', 'cancelled', 'refunded', 'delivered'];
        const update = { updated_at: new Date().toISOString() };
        if (status && allowed.includes(status)) update.status = status;
        if (delivery_status) update.delivery_status = delivery_status;
        if (notes !== undefined) update.notes = notes;
        const { error } = await supabase.from('orders').update(update).eq('id', id);
        if (error) throw error;
        return json({ success: true });
      }

      // ── Admin: Users ──────────────────────────────────────
      if (path === '/api/admin/users' && method === 'GET') {
        requireAdmin(request);
        const { data, error } = await supabase.from('users').select('id,name,email,phone,address,role,created_at').order('created_at', { ascending: false });
        if (error) throw error;
        return json({ success: true, users: data || [] });
      }

      // ── Admin: Products ───────────────────────────────────
      if (path === '/api/admin/products' && method === 'GET') {
        requireAdmin(request);
        const { data, error } = await supabase.from('products').select('id,name,brand,price,old_price,icon,category,badge,specs,images,rating,reviews,stock,active,created_at').order('id', { ascending: false });
        if (error) throw error;
        return json({ success: true, products: data || [] });
      }

      if (path === '/api/admin/products' && method === 'POST') {
        requireAdmin(request);
        const { name, brand = '', description = '', price, old_price = null, icon = '🌸', category = '', badge = '', specs = [], images = [], rating = 4.5, reviews = 0, stock = 100 } = body;
        if (!name || !price) return json({ success: false, message: 'name & price required' }, 400);
        const { data, error } = await supabase.from('products').insert({ name, brand, description, price: +price, old_price: old_price || null, icon, category, badge, specs, images, rating: +rating || 4.5, reviews: +reviews || 0, stock: +stock || 100, active: true }).select('id').single();
        if (error) throw error;
        return json({ success: true, id: data.id, message: 'Product created' }, 201);
      }

      if (path.match(/^\/api\/admin\/products\/\d+$/) && method === 'PUT') {
        requireAdmin(request);
        const id = path.split('/').pop();
        const { name, brand = '', description = '', price, old_price = null, icon = '🌸', category = '', badge = '', specs = [], images = [], rating = 4.5, stock = 100, active } = body;
        if (!name || !price) return json({ success: false, message: 'name & price required' }, 400);
        const update = { name, brand, description, price: +price, old_price: old_price || null, icon, category, badge, specs, images, rating: +rating || 4.5, stock: +stock || 100, updated_at: new Date().toISOString() };
        if (active !== undefined) update.active = Boolean(active);
        const { error } = await supabase.from('products').update(update).eq('id', id);
        if (error) throw error;
        return json({ success: true, message: 'Product updated' });
      }

      if (path.match(/^\/api\/admin\/products\/\d+$/) && method === 'DELETE') {
        requireAdmin(request);
        const id = path.split('/').pop();
        const { error } = await supabase.from('products').update({ active: false }).eq('id', id);
        if (error) throw error;
        return json({ success: true, message: 'Product deleted' });
      }

      // ── Static assets → serve via ASSETS binding ──────────
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ success: false, message: 'Not found' }, 404);

    } catch (e) {
      if (e.status) return json({ success: false, message: e.message }, e.status);
      console.error('[NyKa Worker Error]', e);
      return json({ success: false, message: e.message || 'Internal server error' }, 500);
    }
  }
};
