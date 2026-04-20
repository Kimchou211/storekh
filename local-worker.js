// ═══════════════════════════════════════════════════════════════
//  NyKa Shop — Local Test Server  (ជំនួស Cloudflare Worker)
//  node local-worker.js
//  ប្រើសម្រាប់ test localhost ប៉ុណ្ណោះ
// ═══════════════════════════════════════════════════════════════
//
//  ១. npm install express
//  ២. បំពេញ config ខាងក្រោម
//  ៣. node local-worker.js
//  ៤. ក្នុង index.html ប្ដូរ: const WORKER = 'http://localhost:3001'
//  ៥. បើក ngrok: ngrok http 3001  → copy https URL
//  ៦. set webhook:
//     https://api.telegram.org/botTOKEN/setWebhook?url=NGROK_URL/webhook
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const app     = express();
app.use(express.json());

// ─── CONFIG ── ប្ដូរត្រង់នេះ ───────────────────────────────────
const TG_TOKEN   = 'YOUR_BOT_TOKEN';        // ពី @BotFather
const TG_CHAT_ID = 'YOUR_CHAT_ID';          // ពី @userinfobot
const TG_CONTACT = 'https://t.me/krenkimchou';
const ADMIN_KEY  = 'admin123';              // secret សម្រាប់ confirm
const PORT       = 3001;
// ────────────────────────────────────────────────────────────────

// In-memory store (ជំនួស Cloudflare KV)
const store       = {};   // order data  { [bill]: orderObj }
const userOrders  = {};   // user orders { [userId]: [bill, ...] }

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ── Health check ───────────────────────────────────────────────
app.get('/', (_, res) => res.json({ ok: true, service: 'NyKa Local Worker', time: new Date().toISOString() }));

// ── POST /order/create ─────────────────────────────────────────
app.post('/order/create', async (req, res) => {
  const { bill, amount, userId='', userName, userEmail, userPhone='', items=[] } = req.body;
  if (!bill || !amount) return res.status(400).json({ success: false, message: 'Missing bill or amount' });

  const order = {
    bill, amount: +amount, userName, userEmail, userPhone,
    items, userId, status: 'pending',
    createdAt: new Date().toISOString(), confirmedAt: null,
  };
  store[bill] = order;

  // Append to user order list
  if (userId) {
    if (!userOrders[userId]) userOrders[userId] = [];
    if (!userOrders[userId].includes(bill)) userOrders[userId].push(bill);
  }

  console.log(`\n📦 Order received: ${bill} | $${amount} | ${userName}`);

  // Send Telegram with inline Confirm button
  const tgOk = await sendTelegram(bill, order);
  console.log(`✈️  Telegram sent: ${tgOk}`);

  res.json({ success: true, billNumber: bill, telegramSent: tgOk });
});

// ── GET /order/:bill — browser polls this ──────────────────────
app.get('/order/:bill', (req, res) => {
  const order = store[req.params.bill];
  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({
    status:      order.status,
    bill:        order.bill,
    amount:      order.amount,
    confirmedAt: order.confirmedAt,
    items:       order.items,
    userName:    order.userName,
    userEmail:   order.userEmail,
  });
});

// ── POST /order/confirm — from admin panel ─────────────────────
app.post('/order/confirm', async (req, res) => {
  const { bill, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ success: false, message: 'Unauthorized' });
  const result = await confirmOrder(bill);
  res.json(result);
});

// ── GET /orders/user/:userId ───────────────────────────────────
app.get('/orders/user/:userId', (req, res) => {
  const bills  = userOrders[req.params.userId] || [];
  const orders = bills.slice().reverse().map(b => store[b]).filter(Boolean);
  res.json({ success: true, orders });
});

// ── POST /webhook — Telegram bot callbacks ─────────────────────
app.post('/webhook', async (req, res) => {
  const update = req.body;
  console.log('\n📨 Telegram update:', JSON.stringify(update).slice(0, 200));

  if (update.callback_query) {
    const cb   = update.callback_query;
    const data = cb.data || '';

    if (data.startsWith('confirm:')) {
      const bill   = data.replace('confirm:', '');
      const result = await confirmOrder(bill);
      console.log(`✅ Confirm result for ${bill}:`, result.success ? 'OK' : result.message);

      // Answer callback query (removes loading on button)
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text:       result.success ? `✅ Confirmed: ${bill}` : `⚠️ ${result.message}`,
        show_alert: false,
      });

      // Edit button → show confirmed
      if (result.success) {
        await tgApi('editMessageReplyMarkup', {
          chat_id:    cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [[
            { text: '✅ បានបញ្ជាក់រួចហើយ ✓', callback_data: 'done' }
          ]]},
        });
      }
    }

    if (data === 'done') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'បានបញ្ជាក់រួចហើយ ✅', show_alert: false });
    }
  }

  res.json({ ok: true });
});

// ─── HELPERS ──────────────────────────────────────────────────
async function confirmOrder(bill) {
  const order = store[bill];
  if (!order)              return { success: false, message: 'Order not found' };
  if (order.status==='paid') return { success: true,  message: 'Already confirmed', order };

  order.status      = 'paid';
  order.confirmedAt = new Date().toISOString();

  // Send confirmed notification to Telegram
  await tgApi('sendMessage', {
    chat_id:    TG_CHAT_ID,
    parse_mode: 'HTML',
    text: `✅ <b>បញ្ជាក់ការទូទាត់ជោគជ័យ!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📋 <b>Bill:</b> <code>${bill}</code>\n👤 ${order.userName||'Guest'}\n💰 <b>$${(+order.amount).toFixed(2)}</b>\n🕐 ${new Date().toLocaleString('km-KH')}`,
  });

  console.log(`\n✅ Order confirmed: ${bill}`);
  return { success: true, order };
}

async function sendTelegram(bill, order) {
  const bar       = '━━━━━━━━━━━━━━━━━━━━━━';
  const itemsText = (order.items||[])
    .map(i => `  • ${i.icon||''} <b>${i.name}</b>  ×${i.qty||1}  →  <b>$${((+i.price)*(i.qty||1)).toFixed(2)}</b>`)
    .join('\n') || '  (គ្មានទំនិញ)';

  const text = `🛍 <b>ការបញ្ជាទិញថ្មី — NyKa Shop</b>
${bar}
📋 <b>Bill:</b> <code>${bill}</code>
👤 <b>អតិថិជន:</b> ${order.userName||'Guest'}
📧 <b>Email:</b> ${order.userEmail||'—'}
${order.userPhone ? `📱 <b>Tel:</b> ${order.userPhone}` : ''}
${bar}
🛒 <b>ទំនិញ:</b>
${itemsText}
${bar}
💰 <b>សរុប: $${(+order.amount).toFixed(2)}</b>
✈️ <b>Telegram Payment — រង់ចាំ Confirm</b>
🕐 ${new Date().toLocaleString('km-KH')}
${bar}`;

  const ok = await tgApi('sendMessage', {
    chat_id:      TG_CHAT_ID,
    parse_mode:   'HTML',
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Confirm ការទូទាត់', callback_data: `confirm:${bill}` },
      ]],
    },
  });
  return ok;
}

async function tgApi(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) console.error(`❌ Telegram ${method} error:`, d.description);
    return d.ok;
  } catch(e) {
    console.error(`❌ Telegram ${method} fetch error:`, e.message);
    return false;
  }
}

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  🌸  NyKa Local Worker  →  port ${PORT}          ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  📦  Orders  : http://localhost:${PORT}/order/   ║`);
  console.log(`║  📨  Webhook : http://localhost:${PORT}/webhook  ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  ⚠️  index.html ប្ដូរ WORKER ទៅ:               ║`);
  console.log(`║      http://localhost:${PORT}                   ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log('📋 ជំហាន test Telegram:');
  console.log('   1. npm install -g ngrok');
  console.log('   2. ngrok http 3001');
  console.log('   3. copy https://xxxx.ngrok.io');
  console.log(`   4. បើក browser: https://api.telegram.org/bot${TG_TOKEN}/setWebhook?url=https://xxxx.ngrok.io/webhook`);
  console.log('   5. ចូល index.html ហើយ test ទិញ!\n');
});