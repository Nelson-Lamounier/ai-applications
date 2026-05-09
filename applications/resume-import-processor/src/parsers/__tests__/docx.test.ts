import * as fs from 'node:fs'
import * as path from 'node:path'

const mockExtractRawText = jest.fn()
jest.mock('mammoth', () => ({
  extractRawText: mockExtractRawText,
}))

import { extractTextFromDocx } from '../docx'

const FIXTURE = path.join(__dirname, 'fixtures/Nelson-Leao-Resume-CV.docx')

beforeEach(() => {
  mockExtractRawText.mockReset()
})

describe('extractTextFromDocx — Nelson-Leao-Resume-CV.docx', () => {
  it('extracts text from the fixture DOCX', async () => {
    const buf = fs.readFileSync(FIXTURE)

    mockExtractRawText.mockResolvedValueOnce({
      value: 'Nelson Lamounier Leao\nCloud & DevOps Engineer\nExperience: Senior Engineer at Acme',
      messages: [],
    })

    const text = await extractTextFromDocx(buf)

    expect(text).toContain('Nelson')
    expect(text.length).toBeGreaterThan(0)
    expect(mockExtractRawText).toHaveBeenCalledTimes(1)
    expect(mockExtractRawText).toHaveBeenCalledWith({ buffer: buf })
  })
})

describe('extractTextFromDocx — empty document', () => {
  it('throws when mammoth returns no text', async () => {
    mockExtractRawText.mockResolvedValueOnce({ value: '   ', messages: [] })

    const buf = Buffer.from('fake-docx-content')

    await expect(extractTextFromDocx(buf)).rejects.toThrow(
      'DOCX contains no extractable text',
    )
  })
})

describe('extractTextFromDocx — mammoth failure', () => {
  it('propagates mammoth errors', async () => {
    mockExtractRawText.mockRejectedValueOnce(new Error('Invalid ZIP archive'))

    const buf = Buffer.from('not-a-docx')

    await expect(extractTextFromDocx(buf)).rejects.toThrow('Invalid ZIP archive')
  })
})
