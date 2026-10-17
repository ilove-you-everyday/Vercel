'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const ORIGINAL_LOAD = Module._load;
const records = [];
let nextId = 1;
const ID_BASE = '0123456789abcdef';
const idFor = n => (ID_BASE + String(n).padStart(8, '0')).slice(0, 24);
const sameId = (a, b) => String(a?._id ?? a) === String(b?._id ?? b);
function matches(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => key === '_id' ? sameId(doc._id, value) : doc[key] === value);
}
class FakeObjectId {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
  static isValid(value) { return /^[a-f\d]{24}$/i.test(String(value || '')); }
}
const collection = {
  async createIndex() {},
  find(query = {}) {
    let result = records.filter(doc => matches(doc, query));
    const cursor = {
      sort(sortSpec) {
        const [key, direction] = Object.entries(sortSpec)[0] || [];
        if (key) result = result.slice().sort((a, b) => {
          const av = a[key] ? new Date(a[key]).getTime() : 0;
          const bv = b[key] ? new Date(b[key]).getTime() : 0;
          return (bv - av) * (direction < 0 ? 1 : -1);
        });
        return cursor;
      },
      limit(n) { result = result.slice(0, n); return cursor; },
      async toArray() { return result.map(doc => ({ ...doc })); },
    };
    return cursor;
  },
  async findOne(query = {}) { const doc = records.find(x => matches(x, query)); return doc ? { ...doc } : null; },
  async insertOne(doc) {
    if (records.some(x => x.slug === doc.slug)) { const e = new Error('duplicate key'); e.code = 11000; throw e; }
    const _id = idFor(nextId++);
    records.push({ ...doc, _id });
    return { insertedId: _id };
  },
  async updateOne(query, update) {
    const doc = records.find(x => matches(x, query));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  },
  async deleteOne(query) {
    const index = records.findIndex(x => matches(x, query));
    if (index < 0) return { deletedCount: 0 };
    records.splice(index, 1);
    return { deletedCount: 1 };
  },
};
class FakeMongoClient {
  constructor() {}
  async connect() { return this; }
  db() { return { collection: () => collection }; }
}
Module._load = function(request, parent, isMain) {
  if (request === 'mongodb') return { MongoClient: FakeMongoClient, ObjectId: FakeObjectId };
  return ORIGINAL_LOAD.call(this, request, parent, isMain);
};
process.env.MONGODB_URI = 'mongodb://unit-test.invalid/blog';
process.env.BLOG_DB_NAME = 'halcyon_test';
process.env.BLOG_ADMIN_TOKEN = 'test-admin-secret';
const handler = require('../api/posts.js');

function response() {
  return {
    statusCode: 200, headers: {}, output: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.output += value; },
    json() { return this.output ? JSON.parse(this.output) : null; },
  };
}
async function call(method, url, { token, body, headers = {} } = {}) {
  const req = { method, url, headers: { host: 'localhost', ...headers }, body };
  if (token) req.headers.authorization = `Bearer ${token}`;
  const res = response();
  await handler(req, res);
  return res;
}
(async () => {
  let res = await call('OPTIONS', '/api/posts');
  assert.equal(res.statusCode, 204, 'OPTIONS should be supported');

  res = await call('PATCH', '/api/posts');
  assert.equal(res.statusCode, 405, 'unsupported methods should return 405');

  res = await call('POST', '/api/posts', { body: { title: 'A', content: 'B' } });
  assert.equal(res.statusCode, 401, 'public users must not create posts');

  res = await call('GET', '/api/posts?admin=1');
  assert.equal(res.statusCode, 401, 'admin listing must require a token');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: { title: ' ', content: 'missing title' } });
  assert.equal(res.statusCode, 400, 'empty titles must be rejected');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: '{invalid json' });
  assert.equal(res.statusCode, 400, 'malformed JSON must be rejected');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: [] });
  assert.equal(res.statusCode, 400, 'non-object post bodies must be rejected');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: { title: 'Too long', content: 'x'.repeat(500001) } });
  assert.equal(res.statusCode, 400, 'oversized post bodies must be rejected by server validation');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: { title: 'Test Post', slug: 'test-post', content: '# Hello', tags: ['one', 'one'], published: true } });
  assert.equal(res.statusCode, 201, 'admin should create a valid post');
  const created = res.json().post;
  assert.equal(created.slug, 'test-post');
  assert.deepEqual(created.tags, ['one']);
  const postId = created._id;

  res = await call('GET', '/api/posts');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().posts.length, 1);
  assert.equal(Object.hasOwn(res.json().posts[0], 'content'), false, 'list endpoint must not return full post bodies');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: { title: 'Draft Post', slug: 'draft-post', content: 'draft body', published: false } });
  assert.equal(res.statusCode, 201, 'admin should be able to save drafts');
  res = await call('GET', '/api/posts');
  assert.equal(res.json().posts.length, 1, 'drafts must not be visible to public listing');

  res = await call('GET', '/api/posts?slug=draft-post');
  assert.equal(res.statusCode, 404, 'draft detail must not be available publicly');

  res = await call('GET', `/api/posts?id=${created._id}`);
  assert.equal(res.statusCode, 403, 'public ID lookup must not expose private records');

  res = await call('PUT', '/api/posts?id=bad-id', { token: 'test-admin-secret', body: { title: 'A', content: 'B' } });
  assert.equal(res.statusCode, 400, 'malformed document IDs must be rejected');

  res = await call('GET', '/api/posts?slug=test-post');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().post.content, '# Hello', 'detail endpoint should return the full body');

  res = await call('POST', '/api/posts', { token: 'test-admin-secret', body: { title: 'Duplicate', slug: 'test-post', content: 'body', published: true } });
  assert.equal(res.statusCode, 409, 'duplicate slugs should return a conflict');

  res = await call('PUT', `/api/posts?id=${postId}`, { token: 'test-admin-secret', body: { title: 'Updated', slug: 'updated', content: 'Updated body', tags: ['next'], published: false } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().post.title, 'Updated');
  assert.equal(res.json().post.published, false);

  res = await call('GET', '/api/posts?admin=1', { token: 'test-admin-secret' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().posts.length, 2, 'admin listing should include both published and draft posts');

  res = await call('DELETE', `/api/posts?id=${postId}`, { token: 'test-admin-secret' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  res = await call('GET', '/api/posts');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().posts.length, 0, 'deleted posts should no longer be public');

  delete require.cache[require.resolve('../api/posts.js')];
  delete process.env.MONGODB_URI;
  const noDbHandler = require('../api/posts.js');
  const noDbRes = response();
  await noDbHandler({ method: 'GET', url: '/api/posts', headers: { host: 'localhost' } }, noDbRes);
  assert.equal(noDbRes.statusCode, 503, 'missing database configuration should fail safely');
  process.env.MONGODB_URI = 'mongodb://unit-test.invalid/blog';

  console.log('API unit tests passed: method gating, authorization, malformed/oversized input, create/list/detail/update/delete, draft privacy, public-ID denial, duplicate slug, and safe database-configuration failure.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = ORIGINAL_LOAD; });
