const { MongoClient, ObjectId } = require('mongodb');
const { timingSafeEqual } = require('node:crypto');

const env = (key) => String(process.env[key] || '').trim();
let clientPromise;
let postsCollectionPromise;

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

function getClient() {
  const uri = env('MONGODB_URI');
  if (!uri) throw new Error('MONGODB_URI is not configured');
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 5,
      minPoolSize: 0,
    });
    clientPromise = client.connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

async function getPostsCollection() {
  if (!postsCollectionPromise) {
    postsCollectionPromise = (async () => {
      const client = await getClient();
      const db = client.db(env('BLOG_DB_NAME') || 'halcyon_blog');
      const posts = db.collection('posts');
      await Promise.all([
        posts.createIndex({ slug: 1 }, { unique: true }),
        posts.createIndex({ published: 1, publishedAt: -1, updatedAt: -1 }),
      ]);
      return posts;
    })().catch((error) => {
      postsCollectionPromise = undefined;
      throw error;
    });
  }
  return postsCollectionPromise;
}

function isAdmin(req) {
  const configured = env('BLOG_ADMIN_TOKEN');
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!configured || !supplied) return false;
  const expected = Buffer.from(configured, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug || `post-${Date.now().toString(36)}`;
}

function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('请求内容格式错误');
    error.statusCode = 400;
    throw error;
  }
  const title = String(payload.title || '').trim();
  const content = String(payload.content || '');
  if (!title || title.length > 180) {
    const error = new Error('标题必填且不能超过 180 个字符');
    error.statusCode = 400;
    throw error;
  }
  if (!content.trim() || content.length > 500000) {
    const error = new Error('正文必填，且不能超过 500000 个字符');
    error.statusCode = 400;
    throw error;
  }
  const rawTags = Array.isArray(payload.tags) ? payload.tags : [];
  const tags = [...new Set(rawTags
    .map((tag) => String(tag).trim().slice(0, 40))
    .filter(Boolean))].slice(0, 20);
  return {
    title,
    slug: slugify(payload.slug || title),
    content,
    tags,
    published: payload.published === true,
  };
}

function publicPost(post) {
  return {
    _id: String(post._id),
    title: post.title,
    slug: post.slug,
    content: post.content,
    tags: Array.isArray(post.tags) ? post.tags : [],
    published: Boolean(post.published),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    publishedAt: post.publishedAt || null,
  };
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      const raw = String(req.body);
      return raw ? JSON.parse(raw) : {};
    }
    return req.body || {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 550000) {
      const error = new Error('请求内容过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function databaseError(res, error) {
  if (error && error.code === 11000) {
    return json(res, 409, { error: '文章路径重复，请修改路径后再保存。' });
  }
  console.error('HALCYON posts API error:', error && (error.stack || error.message) || error);
  return json(res, 503, { error: '文章服务暂时不可用，请检查数据库连接及 Vercel 环境变量。' });
}

module.exports = async function postsHandler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
    res.statusCode = 204;
    return res.end();
  }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
    return json(res, 405, { error: '不支持此请求方式' });
  }

  const url = new URL(req.url || '/api/posts', `https://${req.headers.host || 'localhost'}`);
  const wantsAdmin = url.searchParams.get('admin') === '1';
  const protectedRequest = wantsAdmin || method !== 'GET';
  const adminTokenConfigured = Boolean(env('BLOG_ADMIN_TOKEN'));
  if (protectedRequest && !adminTokenConfigured) {
    return json(res, 503, { error: '后台尚未配置管理员令牌。' });
  }
  if (protectedRequest && !isAdmin(req)) {
    return json(res, 401, { error: '管理员令牌无效。' });
  }

  try {
    const posts = await getPostsCollection();
    if (method === 'GET') {
      if (wantsAdmin) {
        const records = await posts.find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(500).toArray();
        return json(res, 200, { posts: records.map(publicPost) });
      }
      const id = url.searchParams.get('id');
      const slug = url.searchParams.get('slug');
      if (id) return json(res, 403, { error: '访问被拒绝' });
      if (slug) {
        const post = await posts.findOne({ slug, published: true });
        if (!post) return json(res, 404, { error: '未找到文章' });
        return json(res, 200, { post: publicPost(post) });
      }
      const records = await posts.find({ published: true })
        .sort({ publishedAt: -1, updatedAt: -1, createdAt: -1 })
        .limit(200)
        .toArray();
      const list = records.map((post) => {
        const item = publicPost(post);
        delete item.content;
        return item;
      });
      return json(res, 200, { posts: list });
    }

    if (method === 'POST') {
      const payload = validate(await readBody(req));
      const now = new Date();
      const doc = {
        ...payload,
        createdAt: now,
        updatedAt: now,
        publishedAt: payload.published ? now : null,
      };
      const result = await posts.insertOne(doc);
      return json(res, 201, { post: publicPost({ ...doc, _id: result.insertedId }) });
    }

    const id = url.searchParams.get('id');
    if (!id || !ObjectId.isValid(id)) return json(res, 400, { error: '文章 ID 无效' });
    const _id = new ObjectId(id);

    if (method === 'PUT') {
      const payload = validate(await readBody(req));
      const previous = await posts.findOne({ _id });
      if (!previous) return json(res, 404, { error: '文章不存在' });
      const now = new Date();
      const publishedAt = payload.published ? (previous.publishedAt || now) : null;
      await posts.updateOne({ _id }, { $set: { ...payload, updatedAt: now, publishedAt } });
      return json(res, 200, { post: publicPost({ ...previous, ...payload, updatedAt: now, publishedAt }) });
    }

    const result = await posts.deleteOne({ _id });
    if (!result.deletedCount) return json(res, 404, { error: '文章不存在' });
    return json(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof SyntaxError) return json(res, 400, { error: '请求内容不是有效 JSON' });
    if (error && Number.isInteger(error.statusCode)) return json(res, error.statusCode, { error: error.message });
    if (String(error && error.message || '').includes('MONGODB_URI is not configured')) {
      return json(res, 503, { error: '后台尚未配置数据库连接。' });
    }
    return databaseError(res, error);
  }
};
