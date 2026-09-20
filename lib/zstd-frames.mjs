/**
 * Zstandard 多帧解析 —— 从 DSH 会话日志中解码明文。
 *
 * ## 背景
 *
 * DSH 的会话日志（`session[.vN].jsonl.zstd`）是**独立 Zstandard 帧的标准拼接**：
 * 一个仅含 header 行的带校验和帧，后跟每个持久 append 批次一个带校验和帧。
 * 第 1 行永远是 header（不是事件），之后每行是一个 JSON 事件。
 *
 * ## 为什么不能用 Node 内置 API 直接解
 *
 * 实测（Node v24.19.0）：
 *   - `zlib.zstdDecompressSync(buf)` **只解第一帧** —— 435395 字节的文件只解出 207 字节
 *   - `zlib.createZstdDecompress()` 流式解完第一帧后报 `ZSTD_error_prefix_unknown`
 *     （"Unknown frame descriptor"）
 *
 * 因此必须自己走帧边界，再逐帧解压。
 *
 * ## 来源
 *
 * `scanZstdFrames` 的逻辑移植自 DSH 自带包
 * `@deepseek-ai/dsh-session-persistence-jsonl`（`lib/index.js:1298-1361`，MIT 许可），
 * 保证了与官方实现一致的帧边界判定（含 block header / checksum 处理）。
 *
 * @module zstd-frames
 */

import zlib from 'node:zlib';

/** Zstandard 帧魔数 0xFD2FB528，按小端读取。 */
const ZSTD_MAGIC = 4247762216;

/**
 * 在不解压块的前提下定位完整的 Zstandard 帧。
 *
 * @param {Buffer} buffer - 会话日志文件的完整字节。
 * @param {number} [maxFrames] - 可选的完整帧数量上限（仅读 header 时用）。
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 *   完整帧的字节区间；若 EOF 落在某帧中间，`tornStart` 给出该未完成帧的起点。
 * @throws {Error} 帧结构损坏时抛出。
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;

    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;

    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    // 逐块跳过，直到 Last_Block 标志置位
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;

      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;

      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;

      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }

    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/**
 * 解码一个会话日志文件，返回逐帧解压后的完整明文。
 *
 * 撕裂的末帧（进程被中断时可能留下）只贡献其中**完整**的记录，
 * 与官方后端的崩溃恢复语义一致。
 *
 * @param {Buffer} buffer - 会话日志文件的完整字节。
 * @returns {{plaintext: string, frameCount: number, failedFrames: number, tornStart?: number, bytes: number}}
 */
/**
 * 解码资源上限（2026-09-18 第三方评审 P1-5）。
 *
 * 原实现把整个文件读进内存、逐帧全解压、再 `Buffer.concat` 一个**无上限**的明文 ——
 * 而本项目自己的语料里就有单块 53 万字符的思考日志，解压放大不可控。
 * 这里给三个维度各设一条硬线：输入字节、明文总字节、帧数。
 */
export const DECODE_LIMITS = {
  /** 输入文件上限（默认 64 MB）：超过就**不整体解码**。 */
  maxInputBytes: 64 * 1024 * 1024,
  /** 解压后明文上限（默认 256 MB）：防"压缩炸弹"式放大。 */
  maxPlaintextBytes: 256 * 1024 * 1024,
  /** 帧数上限（默认 10000）：`scanZstdFrames` 本来就有这个参数，只是调用时没用。 */
  maxFrames: 10000,
};

export function decodeSessionLog(buffer, options = {}) {
  const maxFrames = options.maxFrames ?? DECODE_LIMITS.maxFrames;
  const maxPlaintextBytes = options.maxPlaintextBytes ?? DECODE_LIMITS.maxPlaintextBytes;
  const maxInputBytes = options.maxInputBytes ?? DECODE_LIMITS.maxInputBytes;

  if (buffer.length > maxInputBytes) {
    // 如实报告"因为超限而没解码"，而不是给一个看起来正常的空结果
    return { plaintext: '', frameCount: 0, failedFrames: 0, tornStart: undefined, bytes: 0, skipped: 'input-too-large' };
  }

  const { frames, tornStart } = scanZstdFrames(buffer, maxFrames);
  const parts = [];
  let failedFrames = 0;
  let total = 0;
  let skipped;

  for (const frame of frames) {
    let out;
    try {
      out = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
    } catch {
      failedFrames += 1;
      continue;
    }
    if (total + out.length > maxPlaintextBytes) {
      skipped = 'plaintext-too-large'; // 保留已解出的部分，并如实报告截断
      break;
    }
    parts.push(out);
    total += out.length;
  }

  const plaintext = Buffer.concat(parts).toString('utf8');
  return {
    plaintext,
    frameCount: frames.length,
    failedFrames,
    tornStart,
    bytes: plaintext.length,
    skipped,
  };
}

/**
 * 把明文按行解析成 JSON 对象数组，跳过无法解析的行。
 *
 * 兼容两类字段命名：当前代际用 `seq`/`time`，v0 旧代际用 `seq0`/`time0`。
 *
 * @param {string} plaintext
 * @returns {{records: object[], parseErrors: number}}
 */
export function parseJsonl(plaintext) {
  const records = [];
  let parseErrors = 0;

  for (const line of plaintext.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }

  return { records, parseErrors };
}
