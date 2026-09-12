import { describe, expect, test } from 'bun:test'

import { LineBuffer } from '../src/fuse-daemon.ts'

/**
 * Regression coverage for Issue #14: the daemon's socket handler used to
 * reassemble newline-delimited requests by decoding each incoming chunk to
 * a string independently (`buffer += chunk.toString()`) before splitting on
 * `\n`. That is unsafe for a byte-oriented streaming protocol — a
 * multi-byte UTF-8 sequence can be split across a chunk boundary at any
 * byte offset, and decoding each half separately (rather than the
 * fully-assembled byte sequence) produces mangled output (U+FFFD
 * replacement characters), even though the original bytes form valid UTF-8
 * once fully assembled.
 *
 * `LineBuffer` fixes this by accumulating raw `Buffer`s and splitting on
 * the raw byte 0x0A, only decoding a complete, fully-assembled line once.
 */

describe('LineBuffer: binary-safe newline-delimited framing', () => {
  test('reassembles a multi-byte UTF-8 character split exactly across a chunk boundary', () => {
    // "日本語" — each character is a 3-byte UTF-8 sequence. Split the
    // buffer in the middle of the first character's byte sequence so that
    // neither half is valid UTF-8 on its own.
    const line = '日本語\n'
    const fullBytes = Buffer.from(line, 'utf-8')

    // Sanity check: splitting mid-sequence and decoding each half
    // independently (the old, buggy behavior) must produce mangled output.
    // The first character '日' encodes to 3 bytes; split after 1 of them.
    const splitAt = 1
    const badFirstHalf = fullBytes.subarray(0, splitAt).toString('utf-8')
    const badSecondHalf = fullBytes.subarray(splitAt).toString('utf-8')
    const buggyResult = badFirstHalf + badSecondHalf
    expect(buggyResult).not.toBe(line)
    expect(buggyResult).toContain('�')

    // Now feed the same split bytes through LineBuffer, as real chunked
    // socket data would arrive.
    const lineBuffer = new LineBuffer()
    const firstLines = lineBuffer.push(fullBytes.subarray(0, splitAt))
    expect(firstLines).toEqual([])

    const secondLines = lineBuffer.push(fullBytes.subarray(splitAt))
    expect(secondLines).toEqual(['日本語'])
  })

  test('reassembles a 4-byte emoji split across a chunk boundary', () => {
    const line = 'contact: 🎉\n'
    const fullBytes = Buffer.from(line, 'utf-8')
    // 🎉 is 4 bytes; split in the middle of it (2 bytes in).
    const emojiStart = Buffer.from('contact: ', 'utf-8').length
    const splitAt = emojiStart + 2

    const lineBuffer = new LineBuffer()
    expect(lineBuffer.push(fullBytes.subarray(0, splitAt))).toEqual([])
    expect(lineBuffer.push(fullBytes.subarray(splitAt))).toEqual([
      'contact: 🎉',
    ])
  })

  test('handles a single chunk containing multiple complete lines', () => {
    const lineBuffer = new LineBuffer()
    const chunk = Buffer.from('line one\nline two\nline three\n', 'utf-8')
    expect(lineBuffer.push(chunk)).toEqual([
      'line one',
      'line two',
      'line three',
    ])
  })

  test('retains a trailing partial line across multiple pushes with no newline yet', () => {
    const lineBuffer = new LineBuffer()
    expect(lineBuffer.push(Buffer.from('partial', 'utf-8'))).toEqual([])
    expect(lineBuffer.push(Buffer.from(' line', 'utf-8'))).toEqual([])
    expect(lineBuffer.push(Buffer.from('\n', 'utf-8'))).toEqual([
      'partial line',
    ])
  })

  test('handles an empty chunk without emitting spurious lines', () => {
    const lineBuffer = new LineBuffer()
    expect(lineBuffer.push(Buffer.alloc(0))).toEqual([])
    expect(lineBuffer.push(Buffer.from('hi\n', 'utf-8'))).toEqual(['hi'])
  })

  test('handles a very long line arriving split across many small chunks', () => {
    const lineBuffer = new LineBuffer()
    const payload = `{"op":"write","data":"${'x'.repeat(10_000)}"}`
    const fullBytes = Buffer.from(`${payload}\n`, 'utf-8')

    const chunkSize = 7 // deliberately awkward, non-power-of-two size
    let lines: string[] = []
    for (let i = 0; i < fullBytes.length; i += chunkSize) {
      lines = lines.concat(
        lineBuffer.push(fullBytes.subarray(i, i + chunkSize)),
      )
    }

    expect(lines).toEqual([payload])
  })

  test('preserves an empty line as an empty string', () => {
    const lineBuffer = new LineBuffer()
    expect(lineBuffer.push(Buffer.from('\n', 'utf-8'))).toEqual([''])
  })

  test('preserves an empty line adjacent to non-empty lines in the same chunk', () => {
    const lineBuffer = new LineBuffer()
    const chunk = Buffer.from('a\n\nb\n', 'utf-8')
    expect(lineBuffer.push(chunk)).toEqual(['a', '', 'b'])
  })
})
