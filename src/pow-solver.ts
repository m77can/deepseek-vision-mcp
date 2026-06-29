/**
 * DeepSeek PoW (Proof of Work) 挑战求解器
 * 
 * 使用 WASM 模块计算哈希，解决 DeepSeek 的 PoW 挑战
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 挑战配置 */
interface PowConfig {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path?: string;
}

let wasmInstance: WebAssembly.Instance | null = null;

async function initWasm(): Promise<WebAssembly.Instance> {
  if (wasmInstance) return wasmInstance;

  const wasmPath = join(__dirname, 'wasm', 'sha3_wasm_bg.7b9ca65ddd.wasm');
  const wasmBytes = readFileSync(wasmPath);

  const module = await WebAssembly.compile(wasmBytes);
  wasmInstance = await WebAssembly.instantiate(module, {
    // wasm_bindgen 导入
    './sha3_wasm_bg.js': {
      __wbindgen_throw: (_ptr: number, _len: number) => {
        throw new Error('WASM throw');
      },
    },
  });

  return wasmInstance;
}

/**
 * 将字符串写入 WASM 线性内存
 */
function writeMemory(memory: WebAssembly.Memory, instance: WebAssembly.Instance, text: string): { ptr: number; len: number } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  const length = encoded.length;

  const alloc = instance.exports.__wbindgen_export_0 as CallableFunction;
  const ptr = alloc(length, 1) as number;

  const view = new Uint8Array(memory.buffer);
  for (let i = 0; i < length; i++) {
    view[ptr + i] = encoded[i]!;
  }

  return { ptr, len: length };
}

/**
 * 求解 PoW 挑战
 * @param config 挑战 JSON 字符串或解析后的对象
 * @returns Base64 编码的 PoW 响应头值
 */
export async function solvePowChallenge(configInput: string | Record<string, unknown>): Promise<string> {
  const config: Record<string, unknown> =
    typeof configInput === 'string' ? JSON.parse(configInput) : configInput;

  const algorithm = config.algorithm as string;
  const challenge = config.challenge as string;
  const salt = config.salt as string;
  const difficulty = config.difficulty as number;
  const expire_at = config.expire_at as number;
  const signature = config.signature as string;
  const targetPath = (config.target_path as string) || '/api/v0/chat/completion';

  console.error('[PoW] 算法:', algorithm, 'salt:', salt?.slice(0, 10));
  
  if (algorithm !== 'DeepSeekHashV1') {
    // 尝试其他算法
    if (algorithm !== 'hashcash_v1' && algorithm !== 'hashcash') {
      throw new Error(`不支持的 PoW 算法: ${algorithm}`);
    }
  }

  const inst = await initWasm();
  const memory = inst.exports.memory as WebAssembly.Memory;
  const wasmSolve = inst.exports.wasm_solve as CallableFunction;
  const stackPtr = inst.exports.__wbindgen_add_to_stack_pointer as CallableFunction;

  // 准备参数
  const challengeMem = writeMemory(memory, inst, challenge);
  const prefix = `${salt}_${expire_at}_`;
  const prefixMem = writeMemory(memory, inst, prefix);

  // 调用 WASM
  const retptr = stackPtr(-16) as number;

  try {
    console.error('[PoW] 调用 wasm_solve...');
    console.error('[PoW] challenge:', challenge.slice(0, 30), '...');
    console.error('[PoW] prefix:', prefix);
    
    wasmSolve(
      retptr,
      challengeMem.ptr,
      challengeMem.len,
      prefixMem.ptr,
      prefixMem.len,
      difficulty,
    );

    // 读取结果 - 重新获取 memory.buffer 防止 detached
    const memBuffer = memory.buffer;
    const view = new DataView(memBuffer);
    const status = view.getInt32(retptr, true);

    console.error('[PoW] status:', status);

    if (status === 0) {
      throw new Error('PoW 求解失败');
    }

    const value = view.getFloat64(retptr + 8, true);
    const answer = Math.round(value);
    
    console.error('[PoW] answer:', answer);

    // 构建响应
    const result = {
      algorithm,
      challenge,
      salt,
      answer,
      signature,
      target_path: targetPath,
    };

    return btoa(JSON.stringify(result));
  } finally {
    stackPtr(16);
  }
}
