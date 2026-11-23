/**
 * 数据库层：连接云托管 MySQL、建库建表、种入初始数据
 * 环境变量由微信云托管自动注入：
 *   MYSQL_ADDRESS、MYSQL_USERNAME、MYSQL_PASSWORD
 */
const mysql = require('mysql2/promise')

const DB_NAME = process.env.MYSQL_DATABASE || 'campus'

let pool = null

function mysqlAddr() {
  const raw = String(process.env.MYSQL_ADDRESS || '').trim()
  const [host, port] = raw.split(':')
  return { host: host || '127.0.0.1', port: Number(port) || 3306 }
}

function baseConfig() {
  const { host, port } = mysqlAddr()
  return {
    host,
    port,
    user: process.env.MYSQL_USERNAME || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    charset: 'utf8mb4'
  }
}

function getPool() {
  if (pool) return pool
  pool = mysql.createPool({
    ...baseConfig(),
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0
  })
  return pool
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS services (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    cat VARCHAR(32) NOT NULL DEFAULT 'life',
    summary VARCHAR(255) NOT NULL DEFAULT '',
    location VARCHAR(255) NOT NULL DEFAULT '',
    open_time VARCHAR(128) NOT NULL DEFAULT '',
    phone VARCHAR(64) NOT NULL DEFAULT '',
    notice TEXT,
    materials TEXT,
    entry_type VARCHAR(32) NOT NULL DEFAULT 'window',
    app_id VARCHAR(64) NOT NULL DEFAULT '',
    short_link VARCHAR(512) NOT NULL DEFAULT '',
    oa_name VARCHAR(128) NOT NULL DEFAULT '',
    link VARCHAR(512) NOT NULL DEFAULT '',
    is_common TINYINT(1) NOT NULL DEFAULT 0,
    sort INT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS settings (
    k VARCHAR(64) NOT NULL PRIMARY KEY,
    v MEDIUMTEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS users (
    openid VARCHAR(64) NOT NULL PRIMARY KEY,
    nick VARCHAR(64) NOT NULL DEFAULT '',
    avatar VARCHAR(255) NOT NULL DEFAULT '',
    status TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS shops (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    place VARCHAR(128) NOT NULL DEFAULT '',
    desc_text VARCHAR(255) NOT NULL DEFAULT '',
    tags VARCHAR(128) NOT NULL DEFAULT '',
    base_likes INT NOT NULL DEFAULT 0,
    base_score DECIMAL(3,1) NOT NULL DEFAULT 4.0,
    base_comments INT NOT NULL DEFAULT 0,
    sort INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS shop_likes (
    shop_id VARCHAR(64) NOT NULL,
    openid VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shop_id, openid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS shop_comments (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    shop_id VARCHAR(64) NOT NULL,
    openid VARCHAR(64) NOT NULL DEFAULT '',
    nick VARCHAR(64) NOT NULL DEFAULT '',
    content VARCHAR(500) NOT NULL,
    score TINYINT NOT NULL DEFAULT 5,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_shop (shop_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
]

// 服务数据是整包替换的，启动时如果表空就灌种子
async function seedIfEmpty(seed) {
  const db = getPool()
  const [rows] = await db.query('SELECT COUNT(*) AS n FROM services')
  const count = rows[0] ? rows[0].n : 0
  if (count > 0) return { seeded: false, count }

  if (!seed || !Array.isArray(seed.services) || !seed.services.length) {
    return { seeded: false, count }
  }

  const values = seed.services.map(toRow)
  const sql = `INSERT INTO services
    (id, name, cat, summary, location, open_time, phone, notice, materials,
     entry_type, app_id, short_link, oa_name, link, is_common, sort)
    VALUES ?`
  await db.query(sql, [values])

  await setSetting('version', String(seed.version || 1))
  await setSetting('notice', String(seed.notice || ''))

  return { seeded: true, count: values.length }
}

function toRow(s) {
  return [
    String(s.id || '').slice(0, 64),
    String(s.name || '').slice(0, 128),
    String(s.cat || 'life').slice(0, 32),
    String(s.summary || '').slice(0, 255),
    String(s.location || '').slice(0, 255),
    String(s.openTime || '').slice(0, 128),
    String(s.phone || '').slice(0, 64),
    String(s.notice || ''),
    JSON.stringify(Array.isArray(s.materials) ? s.materials : []),
    String(s.entryType || 'window').slice(0, 32),
    String(s.appId || '').slice(0, 64),
    String(s.shortLink || '').slice(0, 512),
    String(s.oaName || '').slice(0, 128),
    String(s.link || '').slice(0, 512),
    s.isCommon ? 1 : 0,
    Number(s.sort) || 0
  ]
}

function fromRow(r) {
  let materials = []
  try {
    materials = JSON.parse(r.materials || '[]')
  } catch (e) {
    materials = []
  }
  if (!Array.isArray(materials)) materials = []

  return {
    id: r.id,
    name: r.name,
    cat: r.cat,
    summary: r.summary,
    location: r.location,
    openTime: r.open_time,
    phone: r.phone,
    notice: r.notice || '',
    materials,
    entryType: r.entry_type,
    appId: r.app_id,
    shortLink: r.short_link,
    oaName: r.oa_name,
    link: r.link,
    isCommon: !!r.is_common,
    sort: r.sort
  }
}

async function getSetting(k, fallback = '') {
  const db = getPool()
  const [rows] = await db.query('SELECT v FROM settings WHERE k = ? LIMIT 1', [k])
  return rows[0] ? rows[0].v : fallback
}

async function setSetting(k, v) {
  const db = getPool()
  await db.query(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [k, String(v ?? '')]
  )
}

async function bumpVersion() {
  const cur = Number(await getSetting('version', '0')) || 0
  const next = cur + 1
  await setSetting('version', String(next))
  return next
}

async function listServices() {
  const db = getPool()
  const [rows] = await db.query('SELECT * FROM services ORDER BY sort DESC, id ASC')
  return rows.map(fromRow)
}

async function upsertService(s) {
  const db = getPool()
  const row = toRow(s)
  await db.query(
    `INSERT INTO services
      (id, name, cat, summary, location, open_time, phone, notice, materials,
       entry_type, app_id, short_link, oa_name, link, is_common, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), cat=VALUES(cat), summary=VALUES(summary),
       location=VALUES(location), open_time=VALUES(open_time), phone=VALUES(phone),
       notice=VALUES(notice), materials=VALUES(materials),
       entry_type=VALUES(entry_type), app_id=VALUES(app_id),
       short_link=VALUES(short_link), oa_name=VALUES(oa_name), link=VALUES(link),
       is_common=VALUES(is_common), sort=VALUES(sort), updated_at=NOW()`,
    row
  )
  return fromRow({ ...toRowObj(s), updated_at: new Date() })
}

function toRowObj(s) {
  const r = toRow(s)
  return {
    id: r[0], name: r[1], cat: r[2], summary: r[3], location: r[4],
    open_time: r[5], phone: r[6], notice: r[7], materials: r[8],
    entry_type: r[9], app_id: r[10], short_link: r[11], oa_name: r[12],
    link: r[13], is_common: r[14], sort: r[15]
  }
}

async function deleteService(id) {
  const db = getPool()
  const [res] = await db.query('DELETE FROM services WHERE id = ?', [id])
  return res.affectedRows > 0
}

async function init(seed) {
  const cfg = baseConfig()
  const conn = await mysql.createConnection(cfg)
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    )
  } finally {
    await conn.end()
  }

  const db = getPool()
  for (const sql of DDL) await db.query(sql)

  const seeded = await seedIfEmpty(seed)
  return seeded
}

// ---------- 用户 ----------

function fromUserRow(r) {
  return {
    openid: r.openid,
    nick: r.nick,
    avatar: r.avatar,
    status: Number(r.status),
    createdAt: r.created_at,
    lastLogin: r.last_login
  }
}

async function upsertUser(openid, nick, avatar) {
  const db = getPool()
  await db.query(
    `INSERT INTO users (openid, nick, avatar, status, last_login)
     VALUES (?, ?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE
       nick = IF(VALUES(nick) = '', nick, VALUES(nick)),
       avatar = IF(VALUES(avatar) = '', avatar, VALUES(avatar)),
       last_login = NOW()`,
    [openid, String(nick || '').slice(0, 64), String(avatar || '').slice(0, 255)]
  )
  return getUser(openid)
}

async function getUser(openid) {
  const db = getPool()
  const [rows] = await db.query('SELECT * FROM users WHERE openid = ? LIMIT 1', [openid])
  return rows[0] ? fromUserRow(rows[0]) : null
}

async function listUsers(limit) {
  const db = getPool()
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  const [rows] = await db.query(
    'SELECT * FROM users ORDER BY last_login DESC, created_at DESC LIMIT ?',
    [n]
  )
  return rows.map(fromUserRow)
}

async function setUserStatus(openid, status) {
  const db = getPool()
  const [res] = await db.query('UPDATE users SET status = ? WHERE openid = ?', [
    status ? 1 : 0,
    openid
  ])
  return res.affectedRows > 0
}

// ---------- 美食榜 ----------

const SHOP_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM shop_likes l WHERE l.shop_id = s.id) AS real_likes,
    (SELECT COUNT(*) FROM shop_comments c WHERE c.shop_id = s.id) AS real_comments,
    (SELECT AVG(c.score) FROM shop_comments c WHERE c.shop_id = s.id) AS real_avg
  FROM shops s
`

function shapeShop(r, openid, likedSet) {
  const realLikes = Number(r.real_likes) || 0
  const realComments = Number(r.real_comments) || 0
  const realAvg = r.real_avg === null || r.real_avg === undefined ? null : Number(r.real_avg)

  const totalComments = Number(r.base_comments || 0) + realComments
  let score = Number(r.base_score || 0)
  if (realAvg !== null && realComments > 0) {
    score = (Number(r.base_score || 0) * Number(r.base_comments || 0) + realAvg * realComments) / totalComments
  }
  score = Math.round(score * 10) / 10

  return {
    id: r.id,
    name: r.name,
    place: r.place,
    desc: r.desc_text,
    tags: String(r.tags || '').split(',').filter(Boolean),
    likes: Number(r.base_likes || 0) + realLikes,
    comments: totalComments,
    score,
    liked: likedSet ? likedSet.has(r.id) : false
  }
}

async function listShops(openid) {
  const db = getPool()
  const [rows] = await db.query(SHOP_SELECT)
  let likedSet = new Set()
  if (openid) {
    const [ls] = await db.query('SELECT shop_id FROM shop_likes WHERE openid = ?', [openid])
    likedSet = new Set(ls.map((x) => x.shop_id))
  }
  return rows
    .map((r) => shapeShop(r, openid, likedSet))
    .sort((a, b) => b.likes - a.likes || b.score - a.score)
}

function shapeComment(r) {
  return {
    id: r.id,
    nick: r.nick || '匿名同学',
    content: r.content,
    score: Number(r.score) || 5,
    at: r.created_at
  }
}

async function getShopDetail(id, openid) {
  const db = getPool()
  const [rows] = await db.query(SHOP_SELECT + ' WHERE s.id = ? LIMIT 1', [id])
  if (!rows[0]) return null

  let liked = false
  if (openid) {
    const [ls] = await db.query('SELECT 1 FROM shop_likes WHERE shop_id = ? AND openid = ? LIMIT 1', [id, openid])
    liked = ls.length > 0
  }

  const [cs] = await db.query(
    'SELECT * FROM shop_comments WHERE shop_id = ? ORDER BY id DESC LIMIT 100',
    [id]
  )

  const shop = shapeShop(rows[0], openid, null)
  shop.liked = liked
  shop.commentList = cs.map(shapeComment)
  return shop
}

async function toggleShopLike(shopId, openid) {
  const db = getPool()
  const [exist] = await db.query(
    'SELECT 1 FROM shop_likes WHERE shop_id = ? AND openid = ? LIMIT 1',
    [shopId, openid]
  )
  if (exist.length) {
    await db.query('DELETE FROM shop_likes WHERE shop_id = ? AND openid = ?', [shopId, openid])
    return { liked: false }
  }
  await db.query('INSERT INTO shop_likes (shop_id, openid) VALUES (?, ?)', [shopId, openid])
  return { liked: true }
}

async function addShopComment(shopId, openid, nick, content, score) {
  const db = getPool()
  const [res] = await db.query(
    'INSERT INTO shop_comments (shop_id, openid, nick, content, score) VALUES (?, ?, ?, ?, ?)',
    [shopId, openid, String(nick || '').slice(0, 64), String(content).slice(0, 500), score]
  )
  const [rows] = await db.query('SELECT * FROM shop_comments WHERE id = ?', [res.insertId])
  return rows[0] ? shapeComment(rows[0]) : null
}

async function seedShops(foodSeed) {
  const db = getPool()
  const [rows] = await db.query('SELECT COUNT(*) AS n FROM shops')
  const count = rows[0] ? rows[0].n : 0
  if (count > 0) return { seeded: false, count }

  const list = (foodSeed && foodSeed.shops) || []
  if (!list.length) return { seeded: false, count }

  const values = list.map((s, i) => [
    s.id,
    s.name,
    s.place || '',
    s.desc || '',
    s.tags || '',
    Number(s.baseLikes) || 0,
    Number(s.baseScore) || 4,
    Number(s.baseComments) || 0,
    list.length - i
  ])

  await db.query(
    `INSERT INTO shops (id, name, place, desc_text, tags, base_likes, base_score, base_comments, sort)
     VALUES ?`,
    [values]
  )

  const comments = (foodSeed && foodSeed.comments) || []
  if (comments.length) {
    const cv = comments.map((c) => [
      c.shopId,
      '',
      c.nick || '匿名同学',
      c.content,
      Number(c.score) || 5
    ])
    await db.query(
      'INSERT INTO shop_comments (shop_id, openid, nick, content, score) VALUES ?',
      [cv]
    )
  }

  return { seeded: true, count: values.length, comments: comments.length }
}

module.exports = {
  init,
  getPool,
  listServices,
  upsertService,
  deleteService,
  getSetting,
  setSetting,
  bumpVersion,
  fromRow,
  upsertUser,
  getUser,
  listUsers,
  setUserStatus,
  listShops,
  getShopDetail,
  toggleShopLike,
  addShopComment,
  seedShops
}