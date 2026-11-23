/**
 * 校园服务台 · 云托管后端
 * 小程序走 wx.cloud.callContainer 调用，浏览器走公网域名打开 /admin
 */
const path = require('path')
const crypto = require('crypto')
const express = require('express')

const db = require('./db')
const seed = require('./seed.json')
const foodSeed = require('./food-seed.json')
const gameSeed = require('./game-seed.json')

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
  req.auth = payload
  next()
}

function authAdmin(req, res, next) {
  auth(req, res, () => {
    if (!req.auth || req.auth.role !== 'admin') {
      return res.status(403).json({ ok: false, error: '需要管理员权限' })
    }
    req.admin = req.auth
    next()
  })
}

function authUser(req, res, next) {
  auth(req, res, () => {
    if (!req.auth || req.auth.role !== 'user') {
      return res.status(401).json({ ok: false, error: '请先登录' })
    }
    req.user = req.auth
    next()
  })
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

// ---------- 用户登录（微信 code 换 openid） ----------

const WX_APPID = process.env.WX_APPID || 'wxf284831838d69924'
const WX_SECRET = process.env.WX_SECRET || ''
const USER_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000

async function jscode2session(code) {
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    '?appid=' + encodeURIComponent(WX_APPID) +
    '&secret=' + encodeURIComponent(WX_SECRET) +
    '&js_code=' + encodeURIComponent(code) +
    '&grant_type=authorization_code'

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const data = await res.json()
  if (data.errcode) throw new Error('微信登录失败：' + (data.errmsg || data.errcode))
  if (!data.openid) throw new Error('微信没返回 openid')
  return data
}

app.post('/api/auth/login', async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim()
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 64)
  const avatar = String((req.body && req.body.avatar) || '').slice(0, 255)

  if (!code) return res.status(400).json({ ok: false, error: '缺少登录凭证' })
  if (!WX_SECRET) {
    return res.status(503).json({ ok: false, error: '服务端还没配置 WX_SECRET，登录暂不可用' })
  }

  try {
    const s = await jscode2session(code)
    const user = await db.upsertUser(s.openid, nick, avatar)
    if (!user || user.status !== 1) {
      return res.status(403).json({ ok: false, error: '账号已被禁用' })
    }

    const exp = Date.now() + USER_TOKEN_TTL
    res.json({
      ok: true,
      token: sign({ role: 'user', oid: s.openid, exp }),
      exp,
      user
    })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '微信登录失败' })
  }
})

app.get('/api/auth/me', authUser, async (req, res) => {
  try {
    const user = await db.getUser(req.user.oid)
    if (!user) return res.status(404).json({ ok: false, error: '用户不存在' })
    if (user.status !== 1) return res.status(403).json({ ok: false, error: '账号已被禁用' })
    res.json({ ok: true, user })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ---------- 美食榜 ----------

// 带了用户 token 就顺便判断「我点没点过赞」，没带也能看
function optionalUser(req, res, next) {
  const raw = String(req.headers.authorization || '')
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw
  const payload = verify(token)
  if (payload && payload.role === 'user') req.user = payload
  next()
}

app.get('/api/food/list', optionalUser, async (req, res) => {
  try {
    const shops = await db.listShops(req.user && req.user.oid)
    res.set('Cache-Control', 'no-store')
    res.json({ ok: true, shops })
  } catch (e) {
    res.status(500).json({ ok: false, error: '读取失败' })
  }
})

app.get('/api/food/:id', optionalUser, async (req, res) => {
  try {
    const shop = await db.getShopDetail(String(req.params.id), req.user && req.user.oid)
    if (!shop) return res.status(404).json({ ok: false, error: '这家店还没收录' })
    res.set('Cache-Control', 'no-store')
    res.json({ ok: true, shop })
  } catch (e) {
    res.status(500).json({ ok: false, error: '读取失败' })
  }
})

app.post('/api/food/:id/like', authUser, async (req, res) => {
  try {
    const id = String(req.params.id)
    const r = await db.toggleShopLike(id, req.user.oid)
    const shop = await db.getShopDetail(id, req.user.oid)
    res.json({
      ok: true,
      liked: r.liked,
      likes: shop ? shop.likes : 0,
      comments: shop ? shop.comments : 0,
      score: shop ? shop.score : 0
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/food/:id/comment', authUser, async (req, res) => {
  try {
    const id = String(req.params.id)
    const content = String((req.body && req.body.content) || '').trim()
    const score = Math.min(5, Math.max(1, Number(req.body && req.body.score) || 5))

    if (!content) return res.status(400).json({ ok: false, error: '评论不能为空' })
    if (content.length > 200) return res.status(400).json({ ok: false, error: '评论别超过 200 字' })

    const user = await db.getUser(req.user.oid)
    const comment = await db.addShopComment(id, req.user.oid, (user && user.nick) || '', content, score)
    const shop = await db.getShopDetail(id, req.user.oid)

    res.json({
      ok: true,
      comment,
      score: shop ? shop.score : score,
      comments: shop ? shop.comments : 0
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ---------- 游戏榜 ----------

app.get('/api/game/list', async (req, res) => {
  try {
    const games = await db.listGames()
    res.set('Cache-Control', 'no-store')
    res.json({ ok: true, games })
  } catch (e) {
    res.status(500).json({ ok: false, error: '读取失败' })
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
  res.json({ ok: true, token: sign({ role: 'admin', u, exp }), exp })
})

app.get('/api/admin/overview', authAdmin, async (req, res) => {
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

app.post('/api/admin/service', authAdmin, async (req, res) => {
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

app.delete('/api/admin/service/:id', authAdmin, async (req, res) => {
  try {
    const removed = await db.deleteService(String(req.params.id))
    const version = await db.bumpVersion()
    res.json({ ok: true, removed, version })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/admin/notice', authAdmin, async (req, res) => {
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
app.get('/api/admin/export', authAdmin, async (req, res) => {
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

// 后台：用户列表与禁用
app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const users = await db.listUsers(200)
    res.json({ ok: true, users })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/admin/user/:openid/status', authAdmin, async (req, res) => {
  const openid = String(req.params.openid || '')
  const status = Number(req.body && req.body.status) === 1 ? 1 : 0
  if (!openid) return res.status(400).json({ ok: false, error: '缺少 openid' })
  try {
    const updated = await db.setUserStatus(openid, status)
    res.json({ ok: true, updated, status })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ---------- 后台页面 ----------

app.get('/', (req, res) => res.redirect('/admin'))
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')))

// ---------- 启动 ----------

async function main() {
  try {
    const r = await db.init(seed)
    console.log('[db] ready', JSON.stringify(r))
    const f = await db.seedShops(foodSeed)
    console.log('[db] food', JSON.stringify(f))
    const g = await db.seedGames(gameSeed)
    console.log('[db] games', JSON.stringify(g))
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