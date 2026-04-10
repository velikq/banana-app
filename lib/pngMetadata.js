const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function injectPngMetadata(buffer, key, value) {
  const keyBuf = Buffer.from(key, 'latin1');
  const valBuf = Buffer.from(value, 'latin1');

  const dataLen = keyBuf.length + 1 + valBuf.length;
  const chunkLen = 4 + 4 + dataLen + 4;

  const chunk = Buffer.alloc(chunkLen);

  chunk.writeUInt32BE(dataLen, 0);
  chunk.write('tEXt', 4);
  let offset = 8;
  keyBuf.copy(chunk, offset);
  offset += keyBuf.length;
  chunk.writeUInt8(0, offset);
  offset += 1;
  valBuf.copy(chunk, offset);

  const crcVal = crc32(chunk.slice(4, 4 + 4 + dataLen));
  chunk.writeUInt32BE(crcVal, 8 + dataLen);

  const iendHeader = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]);
  const iendIdx = buffer.lastIndexOf(iendHeader);

  if (iendIdx === -1) return buffer;

  return Buffer.concat([buffer.slice(0, iendIdx), chunk, buffer.slice(iendIdx)]);
}

module.exports = { injectPngMetadata };
