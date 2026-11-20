import { forceLayout } from './layout'

self.onmessage = ({ data }: MessageEvent<Parameters<typeof forceLayout>>) => {
  self.postMessage(forceLayout(...data))
}
