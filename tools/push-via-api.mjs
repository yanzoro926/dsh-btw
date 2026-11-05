#!/usr/bin/env node
// Push the current git tree to GitHub through the REST API.
// Needed on networks where github.com:443 (git smart HTTP) is unreachable
// while api.github.com works. Requires GH_TOKEN with repo scope.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const repo = process.env.PUSH_REPO || 'yanzoro926/dsh-btw'
const branch = process.env.PUSH_BRANCH || 'main'
const message = process.env.PUSH_MESSAGE || 'dsh-btw 0.5.2'
const token = process.env.GH_TOKEN
if (!token) throw new Error('GH_TOKEN is empty')

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-btw-release',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    const error = new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
    error.status = res.status
    throw error
  }
  return text ? JSON.parse(text) : null
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
if (files.length === 0) throw new Error('no tracked files')

// A brand-new empty repository rejects the git/blobs endpoint with 409 until
// it has one commit, so seed it through the contents API first.
const refPath = `/repos/${repo}/git/refs/heads/${branch}`
let parent
try {
  const ref = await api(refPath)
  parent = ref.object.sha
} catch (error) {
  if (error.status !== 404 && error.status !== 409) throw error
  const seed = await api(`/repos/${repo}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Initial commit',
      content: readFileSync('README.md').toString('base64'),
      branch,
    }),
  })
  parent = seed.commit.sha
}

const blobs = []
for (const path of files) {
  const data = readFileSync(path).toString('base64')
  const blob = await api(`/repos/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: data, encoding: 'base64' }),
  })
  blobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
}

const tree = await api(`/repos/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: blobs }),
})
const commit = await api(`/repos/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: parent ? [parent] : [] }),
})

try {
  await api(refPath, { method: 'GET' })
  await api(refPath, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) })
} catch (error) {
  if (error.status !== 404) throw error
  await api(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })
}
console.log(JSON.stringify({ files: files.length, commit: commit.sha, branch }))
