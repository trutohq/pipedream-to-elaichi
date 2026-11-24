import { inflateRawSync } from 'node:zlib'

/**
 * Reads every file of a ZIP archive into memory. Enough for Pipedream's project export
 * (at most 256 MB, stored or deflated entries). Nothing is written to disk, so entry
 * names cannot escape a folder.
 * ponytail: no ZIP64 and no encryption; an archive that needs either is refused with a clear error.
 */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const u16 = (o: number) => view.getUint16(o, true)
  const u32 = (o: number) => view.getUint32(o, true)

  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP file (no end-of-central-directory record)')

  const count = u16(eocd + 10)
  let p = u32(eocd + 16)
  if (p === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported: unzip it and pass the folder')

  const out = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory')
    const flags = u16(p + 8)
    const method = u16(p + 10)
    const compSize = u32(p + 20)
    const nameLen = u16(p + 28)
    const extraLen = u16(p + 30)
    const commentLen = u16(p + 32)
    const localOffset = u32(p + 42)
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error(`ZIP entry ${name} is encrypted`)
    if (u32(localOffset) !== 0x04034b50) throw new Error(`corrupt ZIP local header for ${name}`)
    const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28)
    const data = buf.subarray(start, start + compSize)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)))
    else throw new Error(`ZIP entry ${name} uses compression method ${method}; unzip it and pass the folder`)
  }
  return out
}
