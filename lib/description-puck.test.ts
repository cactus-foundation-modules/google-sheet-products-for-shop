import { describe, it, expect } from 'vitest'
import {
  CELL_CHAR_LIMIT,
  TOO_LARGE_CELL,
  canonicalJson,
  describeDescriptionPuck,
  describeDescriptionPuckCell,
  descriptionPuckCell,
  descriptionPuckChanged,
  readDescriptionPuckCell,
} from '@/modules/google-sheet-products-for-shop/lib/description-puck'
import type { PuckData } from '@/modules/shop/lib/types'

const doc: PuckData = {
  root: { props: { title: 'Chair' } },
  content: [{ type: 'Text', props: { id: 'a', text: 'Comfy' } }],
}

describe('descriptionPuckCell', () => {
  it('writes a product with no design as a blank cell', () => {
    expect(descriptionPuckCell(null)).toBe('')
    expect(descriptionPuckCell(undefined)).toBe('')
  })

  it('writes the document as compact JSON', () => {
    const cell = descriptionPuckCell(doc)
    expect(cell.startsWith('{')).toBe(true)
    expect(cell).not.toContain('\n')
    expect(JSON.parse(cell)).toEqual(doc)
  })

  it('substitutes the sentinel rather than a truncated document', () => {
    const huge: PuckData = { root: {}, content: [{ text: 'x'.repeat(CELL_CHAR_LIMIT + 100) }] }
    expect(descriptionPuckCell(huge)).toBe(TOO_LARGE_CELL)
  })
})

describe('readDescriptionPuckCell', () => {
  it('reads a blank cell as clear', () => {
    expect(readDescriptionPuckCell('').kind).toBe('clear')
    expect(readDescriptionPuckCell('   ').kind).toBe('clear')
  })

  it('reads the too-large sentinel as leave alone', () => {
    expect(readDescriptionPuckCell(TOO_LARGE_CELL).kind).toBe('skip')
  })

  it('round-trips a pushed cell', () => {
    const read = readDescriptionPuckCell(descriptionPuckCell(doc))
    expect(read.kind).toBe('doc')
    if (read.kind === 'doc') expect(read.data).toEqual(doc)
  })

  it('rejects text that is not JSON', () => {
    expect(readDescriptionPuckCell('not json at all').kind).toBe('invalid')
  })

  it('rejects JSON that is not a page design', () => {
    expect(readDescriptionPuckCell('{"content":[]}').kind).toBe('invalid') // no root
    expect(readDescriptionPuckCell('{"root":{}}').kind).toBe('invalid') // no content
    expect(readDescriptionPuckCell('[]').kind).toBe('invalid')
    expect(readDescriptionPuckCell('"a string"').kind).toBe('invalid')
    expect(readDescriptionPuckCell('{"root":[],"content":[]}').kind).toBe('invalid')
    expect(readDescriptionPuckCell('{"root":{},"content":{}}').kind).toBe('invalid')
  })

  it('accepts a design with zones', () => {
    expect(readDescriptionPuckCell('{"root":{},"content":[],"zones":{}}').kind).toBe('doc')
    expect(readDescriptionPuckCell('{"root":{},"content":[],"zones":[]}').kind).toBe('invalid')
  })
})

describe('canonicalJson', () => {
  it('is insensitive to object key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('keeps array order, which is block order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('handles nested structures and nulls', () => {
    expect(canonicalJson({ z: null, a: [{ q: 1, p: 2 }] })).toBe('{"a":[{"p":2,"q":1}],"z":null}')
  })
})

describe('descriptionPuckChanged', () => {
  it('is false for the cell a Push just wrote', () => {
    expect(descriptionPuckChanged(descriptionPuckCell(doc), doc)).toBe(false)
  })

  it('is false when re-indented or re-keyed by hand', () => {
    const reordered = JSON.stringify({ content: doc.content, root: doc.root }, null, 2)
    expect(descriptionPuckChanged(reordered, doc)).toBe(false)
  })

  it('is false for a blank cell on a product with no design', () => {
    expect(descriptionPuckChanged('', null)).toBe(false)
  })

  it('is true when a blank cell clears a stored design', () => {
    expect(descriptionPuckChanged('', doc)).toBe(true)
  })

  it('is true when a design is added to a product that had none', () => {
    expect(descriptionPuckChanged(descriptionPuckCell(doc), null)).toBe(true)
  })

  it('is true when the document differs', () => {
    const edited: PuckData = { ...doc, content: [...doc.content, { type: 'Text' }] }
    expect(descriptionPuckChanged(descriptionPuckCell(edited), doc)).toBe(true)
  })

  it('is false for the too-large sentinel, whatever is stored', () => {
    expect(descriptionPuckChanged(TOO_LARGE_CELL, doc)).toBe(false)
    expect(descriptionPuckChanged(TOO_LARGE_CELL, null)).toBe(false)
  })

  it('is true for an unreadable cell, so the row is reported rather than skipped', () => {
    expect(descriptionPuckChanged('{oops', doc)).toBe(true)
    expect(descriptionPuckChanged('{oops', null)).toBe(true)
  })
})

describe('describeDescriptionPuck', () => {
  it('describes both sides in words, never the raw document', () => {
    expect(describeDescriptionPuck(null)).toBe('no design')
    expect(describeDescriptionPuck(doc)).toBe('design (1 block)')
    expect(describeDescriptionPuck({ root: {}, content: [{}, {}] })).toBe('design (2 blocks)')
    expect(describeDescriptionPuckCell('')).toBe('no design')
    expect(describeDescriptionPuckCell(TOO_LARGE_CELL)).toBe('left as it is')
    expect(describeDescriptionPuckCell('{oops')).toBe('unreadable design')
    expect(describeDescriptionPuckCell(descriptionPuckCell(doc))).toBe('design (1 block)')
  })
})
