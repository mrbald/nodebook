import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { recognizeFigureText } from './figureIntelligence'

describe('local figure OCR', () => {
  it('skips unrecognized rasters and cancelled work', async () => {
    const bytes = new Uint8Array(32)
    await expect(recognizeFigureText(bytes, 'png')).resolves.toBeUndefined()
    await expect(recognizeFigureText(bytes, '../../sample.png')).resolves.toBeUndefined()
    await expect(recognizeFigureText(bytes, 'png', AbortSignal.abort())).resolves.toBeUndefined()
  })

  // Apple Vision's system service must be accessible to the test process.
  // Run with NODEBOOK_TEST_OCR=1 on a plain macOS terminal.
  it.runIf(process.platform === 'darwin' && process.env.NODEBOOK_TEST_OCR === '1')(
    'reads known synthetic raster text with Apple Vision',
    async () => {
      const image = new Resvg(`
        <svg xmlns="http://www.w3.org/2000/svg" width="800" height="220">
          <rect width="800" height="220" fill="white"/>
          <text x="35" y="90" font-family="Helvetica" font-size="50">Quarterly Attendance</text>
          <text x="35" y="173" font-family="Helvetica" font-size="50">March 48</text>
        </svg>
      `).render().asPng()
      const text = await recognizeFigureText(image, 'png')
      expect(text).toMatch(/Quarterly Attendance/i)
      expect(text).toMatch(/March 48/i)
    },
    12_000
  )
})
