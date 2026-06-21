// Rasterize build/icon.svg → build/icon.png (1024×1024). electron-builder
// generates the per-platform .icns/.ico from that PNG at package time.
// Run: npm run gen:icon
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const src = new URL('../build/icon.svg', import.meta.url)
const out = new URL('../build/icon.png', import.meta.url)
const png = new Resvg(readFileSync(src), { fitTo: { mode: 'width', value: 1024 } })
  .render()
  .asPng()
writeFileSync(out, png)
console.log(`wrote build/icon.png (${png.length} bytes)`)
