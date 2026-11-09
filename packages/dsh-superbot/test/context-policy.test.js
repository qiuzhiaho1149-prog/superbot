import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  duplicateNotice, isPlainTextContent, retainRecentReasoning, textOfContent,
} from '../lib/context-policy.js'

const msg = (id, blocks) => ({ role: 'assistant', id, content: blocks })

describe('retainRecentReasoning', () => {
  it('keeps only the last N reasoning-bearing assistant messages', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      msg('a1', [{ type: 'reasoning', text: 'r1' }, { type: 'text', text: 't1' }]),
      msg('a2', [{ type: 'reasoning', text: 'r2' }, { type: 'tool-call', id: 'c1' }]),
      msg('a3', [{ type: 'reasoning', text: 'r3' }, { type: 'text', text: 't3' }]),
    ]
    const result = retainRecentReasoning(messages, 2)
    assert.equal(result.removedBlocks, 1)
    assert.equal(result.removedChars, 2)
    assert.equal(result.keptMessages, 2)
    assert.deepEqual(result.messages[1].content, [{ type: 'text', text: 't1' }])
    assert.deepEqual(result.messages[2].content, [{ type: 'reasoning', text: 'r2' }, { type: 'tool-call', id: 'c1' }])
    assert.deepEqual(result.messages[3].content, [{ type: 'reasoning', text: 'r3' }, { type: 'text', text: 't3' }])
    // original untouched
    assert.equal(messages[1].content.length, 2)
  })

  it('keeps zero reasoning blocks when configured to 0', () => {
    const result = retainRecentReasoning([msg('a', [{ type: 'reasoning', text: 'x' }])], 0)
    assert.equal(result.removedBlocks, 1)
    assert.deepEqual(result.messages[0].content, [])
  })

  it('is a no-op when there is no reasoning', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    const result = retainRecentReasoning(messages, 2)
    assert.equal(result.removedBlocks, 0)
    assert.equal(result.messages, messages)
  })
})

describe('tool result helpers', () => {
  it('only treats plain text content as dedupe-able', () => {
    assert.equal(isPlainTextContent([{ type: 'text', text: 'x' }]), true)
    assert.equal(isPlainTextContent([{ type: 'text', text: 'x' }, { type: 'image' }]), false)
    assert.equal(isPlainTextContent([]), false)
  })

  it('joins text blocks for hashing', () => {
    assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }]), 'a\nb')
  })

  it('notice retains a readable recovery path', () => {
    assert.match(duplicateNotice('/tmp/x.txt'), /\/tmp\/x\.txt/)
  })
})
