/**
 * 校园服务台 · 云托管后端
 * 小程序走 wx.cloud.callContainer 调用，浏览器走公网域名打开 /admin
 */
const path = require('path')
const crypto = require('crypto')
const express = require('express')

const db = require('./db')
const seed = require('./seed.json')

const PORT = Number(process.env.PORT) || 80
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'campus2026'
const TOKEN_SECRET = process.env.ADMIN_SECRET || crypto
  .createHash('sha256')
  .update('campus-hub::' + ADMIN_PASS)
  .digest('hex')

const TOKEN_TTL = 12 * 60 * 60 * 1000

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '512kb' }))

// ---------- 简易签名 token ----------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
  return body + '.' + mac
}

function verify(token) {
  if (!token || typeof token !== 'string') return null
  const idx = token.lastIndexOf('.')
  if (idx < 0) return null
  const body = token.slice(0, idx)
  const mac = token.slice(idx + 1)
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
  if (mac.length !== expect.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload || !payload.exp || payload.exp < Date.now()) return null
    return payload
  } catch (e) {
    return null
  }
}

function auth(req, res, next) {
  const raw = String(req.headers.authorization || '')
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw
  const payload = verify(token)
  if (!payload) return res.status(401).json({ ok: false, error: '登录过期，请重新登录' })
  req.admin = payload
  next()
}

// 登录失败限速：同一 IP 10 分钟内最多 8 次
const fails = new Map()
function throttleKey(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || 'unknown')
}
function checkThrottle(req) {
  const key = throttleKey(req)
  const rec = fails.get(key)
  if (!rec) return true
  if (Date.now() - rec.at > 10 * 60 * 1000) {
    fails.delete(key)
    return true
  }
  return rec.n < 8
}
function markFail(req) {
  const key = throttleKey(req)
  const rec = fails.get(key)
  if (!rec || Date.now() - rec.at > 10 * 60 * 1000) fails.set(key, { n: 1, at: Date.now() })
  else rec.n += 1
}

// ---------- 小程序接口（免鉴权，走微信内网） ----------

app.get('/api/health', async (req, res) => {
  let dbOk = false
  try {
    await db.getPool().query('SELECT 1')
    dbOk = true
  } catch (e) {}
  res.json({ ok: true, db: dbOk, ts: Date.now() })
})

app.get('/api/config', async (req, res) => {
  try {
    const [services, version, notice] = await Promise.all([
      db.listServices(),
      db.getSetting('version', '1'),
      db.getSetting('notice', '')
    ])
    res.set('Cache-Control', 'no-store')
    res.json({
      ok: true,
      version: Number(version) || 1,
      notice,
      services
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: '服务端读取失败' })
  }
})

// ---------- 管理端 ----------

app.post('/api/admin/login', async (req, res) => {
  if (!checkThrottle(req)) {
    return res.status(429).json({ ok: false, error: '尝试次数过多，10 分钟后再试' })
  }

  const u = String((req.body && req.body.username) || '').trim()
  const p = String((req.body && req.body.password) || '')

  if (u !== ADMIN_USER || p !== ADMIN_PASS) {
    markFail(req)
    return res.status(401).json({ ok: false, error: '账号或密码不对' })
  }

  fails.delete(throttleKey(req))
  const exp = Date.now() + TOKEN_TTL
  res.json({ ok: true, token: sign({ u, exp }), exp })
})

app.get('/api/admin/overview', auth, async (req, res) => {
  try {
    const [services, version, notice] = await Promise.all([
      db.listServices(),
      db.getSetting('version', '1'),
      db.getSetting('notice', '')
    ])
    res.json({ ok: true, version: Number(version) || 1, notice, services })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/admin/service', auth, async (req, res) => {
  const s = req.body && req.body.service
  if (!s || !String(s.id || '').trim() || !String(s.name || '').trim()) {
    return res.status(400).json({ ok: false, error: 'id 和名称不能为空' })
  }
  try {
    const saved = await db.upsertService(s)
    const version = await db.bumpVersion()
    res.json({ ok: true, service: saved, version })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.delete('/api/admin/service/:id', auth, async (req, res) => {
  try {
    const removed = await db.deleteService(String(req.params.id))
    const version = await db.bumpVersion()
    res.json({ ok: true, removed, version })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/admin/notice', auth, async (req, res) => {
  const notice = String((req.body && req.body.notice) || '').slice(0, 2000)
  try {
    await db.setSetting('notice', notice)
    const version = await db.bumpVersion()
    res.json({ ok: true, notice, version })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// 导出成小程序本地兜底用的 services.js
app.get('/api/admin/export', auth, async (req, res) => {
  const services = await db.listServices()
  const body = services.map((s) => '  ' + JSON.stringify({
    id: s.id, name: s.name, cat: s.cat, summary: s.summary,
    location: s.location, openTime: s.openTime, phone: s.phone,
    notice: s.notice, materials: s.materials, entryType: s.entryType,
    appId: s.appId, shortLink: s.shortLink, oaName: s.oaName,
    link: s.link, isCommon: s.isCommon, sort: s.sort
  }, null, 2).replace(/\n/g, '\n  ')).join(',\n\n')

  res.type('text/plain; charset=utf-8').send(
    '/** 由云托管后台导出，替换 data/services.js 里的 SERVICES 即可 */\n' +
    'const SERVICES = [\n' + body + '\n]\n\nmodule.exports = { SERVICES }\n'
  )
})

// ---------- 后台页面 ----------

app.get('/', (req, res) => res.redirect('/admin'))
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')))

// ---------- 启动 ----------

async function main() {
  try {
    const r = await db.init(seed)
    console.log('[db] ready', JSON.stringify(r))
  } catch (e) {
    console.error('[db] init failed:', e.message)
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on ${PORT}`)
    console.log(`[server] admin user: ${ADMIN_USER}`)
    console.log(`[server] admin pass: ${ADMIN_PASS === 'campus2026' ? 'campus2026 (默认，请尽快改)' : '已自定义'}`)
  })
}

main()