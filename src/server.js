import express from 'express'
import cors from 'cors'
import QRCode from 'qrcode'
import P from 'pino'
import NodeCache from 'node-cache'

// Baileys (v7 RC) — default export is makeWASocket
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  Browsers
} from 'baileys'

// -----------------------------------------------------------------------------
// Basic state
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'
const WEBHOOK_URL = process.env.WEBHOOK_URL || '' // optional: forward inbound messages

// in-memory message store (simple ring buffer)
const MAX_RECENT = 200
const recentMessages = []
const msgIndex = new Map() // key.id => message

// SSE clients
const sseClients = new Set()

// holds latest QR (string) if any
let latestQR = null

// holds socket/session status
let sock = null
let isConnected = false
let me = null

// simple group metadata cache to reduce WA lookups on send to groups
const groupCache = new NodeCache({ stdTTL: 300, checkperiod: 120 })

// -----------------------------------------------------------------------------
// Helper: add message to memory & notify SSE / webhook
// -----------------------------------------------------------------------------
async function recordInbound(msg) {
  try {
    const { key, message, pushName } = msg
    
    // Extract text from various message types
    let text = null
    if (message) {
      text = message.conversation ||
             message.extendedTextMessage?.text ||
             message.imageMessage?.caption ||
             message.videoMessage?.caption ||
             message.documentMessage?.caption ||
             message.templateButtonReplyMessage?.selectedDisplayText ||
             message.listResponseMessage?.singleSelectReply?.selectedRowId ||
             message.buttonsResponseMessage?.selectedButtonId ||
             null
    }
    
    const item = {
      id: key?.id,
      remoteJid: key?.remoteJid,
      fromMe: !!key?.fromMe,
      pushName: pushName || null,
      timestamp: Date.now(),
      text,
      messageType: message ? Object.keys(message)[0] : 'unknown',
      raw: msg
    }

    console.log(`Message received: from=${item.remoteJid} pushName=${item.pushName} fromMe=${item.fromMe} type=${item.messageType} text="${item.text?.substring(0, 50) || '(no text)'}${item.text?.length > 50 ? '...' : ''}"`)
    
    // Debug: log message structure when text is missing
    if (!text && message) {
      console.log('Message structure:', JSON.stringify(Object.keys(message), null, 2))
    }

    if (item.id) msgIndex.set(item.id, msg)
    recentMessages.push(item)
    if (recentMessages.length > MAX_RECENT) {
      const removed = recentMessages.shift()
      if (removed?.id) msgIndex.delete(removed.id)
    }

    // push to SSE clients
    const payload = `data: ${JSON.stringify({ type: 'message', data: item })}\n\n`
    for (const res of sseClients) res.write(payload)

    // optional webhook forward (Node 18+ has global fetch)
    if (WEBHOOK_URL) {
      console.log(`Attempting webhook forward to: ${WEBHOOK_URL}`)
      fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item)
      })
        .then(() => console.log(`Webhook forwarded successfully to: ${WEBHOOK_URL}`))
        .catch((err) => console.error(`Webhook forward failed: ${err.message}`))
    } else {
      console.log('Webhook forwarding skipped: WEBHOOK_URL not configured')
    }
  } catch (err) {
    console.error('Failed to record inbound message', err)
  }
}

// -----------------------------------------------------------------------------
// Start / restart the Baileys socket
// -----------------------------------------------------------------------------
async function startSock() {
  console.log('Initializing WhatsApp socket...')
  const logger = P({ level: process.env.LOG_LEVEL || 'warn' })

  // Note: useMultiFileAuthState is convenient, but heavy IO for large scale.
  // For a serious deployment, implement a DB-backed auth store. :contentReference[oaicite:2]{index=2}
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  
  // Check if we have stored authentication credentials
  const hasAuth = !!(state.creds?.me?.id)
  if (hasAuth) {
    console.log(`Found existing authentication credentials for: ${state.creds.me.id}`)
  } else {
    console.log('No authentication found - QR code will be generated')
  }

  sock = makeWASocket({
    logger,
    browser: Browsers.macOS('Safari'), // ok for QR login; for pairing-code see docs. :contentReference[oaicite:3]{index=3}
    printQRInTerminal: false, // we serve it via /qr.png
    auth: state,
    // supply a getMessage handler (used by WA when it needs to rehydrate)
    getMessage: async (key) => {
      const cached = key?.id ? msgIndex.get(key.id) : undefined
      return cached // may be undefined if not found; acceptable for most basic flows
    },
    // cache group metadata to avoid rate limits when sending to groups :contentReference[oaicite:4]{index=4}
    cachedGroupMetadata: async (jid) => groupCache.get(jid)
  })

  // Persist auth
  sock.ev.on('creds.update', saveCreds)

  // Connection updates (QR, open/close, etc.) :contentReference[oaicite:5]{index=5}
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // Log connection state changes
    if (connection === 'connecting') {
      console.log('Connecting to WhatsApp...')
    }

    // publish QR to SSE and keep last QR for /qr.png
    if (qr) {
      console.log('QR code generated - awaiting authentication (scan with WhatsApp mobile app)')
      latestQR = qr
      const payload = `data: ${JSON.stringify({ type: 'qr' })}\n\n`
      for (const res of sseClients) res.write(payload)
    }

    if (connection === 'open') {
      isConnected = true
      latestQR = null
      me = sock.user
      console.log(`Connected successfully as: ${me?.name || me?.id || 'unknown'} (${me?.id})`)
      const payload = `data: ${JSON.stringify({ type: 'status', data: { connected: true, me } })}\n\n`
      for (const res of sseClients) res.write(payload)
    } else if (connection === 'close') {
      isConnected = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      
      // Log reason for disconnection
      const reasons = {
        [DisconnectReason.badSession]: 'Bad session',
        [DisconnectReason.connectionClosed]: 'Connection closed',
        [DisconnectReason.connectionLost]: 'Connection lost',
        [DisconnectReason.connectionReplaced]: 'Connection replaced (logged in elsewhere)',
        [DisconnectReason.loggedOut]: 'Logged out',
        [DisconnectReason.restartRequired]: 'Restart required',
        [DisconnectReason.timedOut]: 'Connection timed out'
      }
      const reasonText = reasons[statusCode] || `Unknown (${statusCode})`
      
      console.log(`Connection closed: ${reasonText} - shouldReconnect=${shouldReconnect}`)
      
      const payload = `data: ${JSON.stringify({ type: 'status', data: { connected: false, reason: statusCode } })}\n\n`
      for (const res of sseClients) res.write(payload)
      if (shouldReconnect) {
        console.log('Attempting to reconnect...')
        // recreate the socket
        startSock().catch((e) => {
          logger.error({ e }, 'reconnect failed')
          console.error('Reconnect failed:', e.message)
        })
      } else {
        console.log('Not reconnecting - authentication required (delete ./auth folder to start fresh)')
      }
    }
  })

  // Inbound messages: messages.upsert (notify/append) :contentReference[oaicite:6]{index=6}
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (!Array.isArray(messages)) return
    console.log(`messages.upsert event: type=${type} count=${messages.length}`)
    for (const m of messages) {
      // usually 'notify' are new messages
      if (type === 'notify') await recordInbound(m)
    }
  })

  // Best-effort: cache group metadata when we see it (to speed group sends) :contentReference[oaicite:7]{index=7}
  sock.ev.on('groups.upsert', (groups) => {
    console.log(`Group metadata received: ${groups.length} groups`)
    for (const g of groups) groupCache.set(g.id, g)
  })
}

// kick off the socket once on boot
startSock().catch((err) => {
  console.error('fatal error starting socket', err)
  process.exit(1)
})

// -----------------------------------------------------------------------------
// HTTP API
// -----------------------------------------------------------------------------
const app = express()
app.use(cors())
app.use(express.json())

// Status
app.get('/status', (req, res) => {
  res.json({ connected: isConnected, me, hasQR: !!latestQR })
})

// Serve QR code as PNG (HTTP-refresh this route in a browser until it disappears)
app.get('/qr.png', async (req, res) => {
  try {
    if (!latestQR) {
      res.status(204).end() // no QR to show (likely already connected)
      return
    }
    const buf = await QRCode.toBuffer(latestQR, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 300 })
    res.setHeader('content-type', 'image/png')
    res.send(buf)
  } catch (err) {
    res.status(500).json({ error: 'failed_to_generate_qr' })
  }
})

// SSE stream for live events (QR, status, messages)
app.get('/events', (req, res) => {
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)
  sseClients.add(res)
  console.log(`SSE client connected (total: ${sseClients.size})`)
  req.on('close', () => {
    sseClients.delete(res)
    console.log(`SSE client disconnected (total: ${sseClients.size})`)
    res.end()
  })
})

// Pull recent messages (fallback if you don’t want SSE)
app.get('/messages', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, MAX_RECENT))
  res.json(recentMessages.slice(-limit))
})

// Normalize "to" -> a valid JID string
function normalizeJid(to) {
  // if it already looks like a JID (has '@'), keep as is
  if (/@/.test(to)) return to
  // phone number string -> PN JID
  const digits = (to || '').replace(/[^\d]/g, '')
  if (!digits) throw new Error('invalid_recipient')
  return jidNormalizedUser(`${digits}@s.whatsapp.net`)
}

// Send text message
app.post('/send', async (req, res) => {
  try {
    const { to, message } = req.body || {}
    if (!to || !message) return res.status(400).json({ error: 'to_and_message_required' })
    if (!sock) return res.status(503).json({ error: 'socket_not_ready' })
    const jid = normalizeJid(to)
    console.log(`Sending message: to=${jid} text="${String(message).substring(0, 50)}${message.length > 50 ? '...' : ''}"`)   
    const result = await sock.sendMessage(jid, { text: String(message) })
    console.log(`Message sent: id=${result?.key?.id}`)
    res.json({ ok: true, id: result?.key?.id, to: jid })
  } catch (err) {
    console.error('Send failed:', err.message, err)
    res.status(500).json({ ok: false, error: 'send_failed' })
  }
})

app.listen(PORT, HOST, () => {
  console.log(`WhatsApp service listening on http://${HOST}:${PORT}`)
})
