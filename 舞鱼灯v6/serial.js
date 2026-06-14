// ═══════════════════════════════════════════════════════════════
// serial.js — 鱼竿 Arduino 通信模块
// 功能：WebSerial 双向通信（发送鱼种指令 + 接收FSR张力读值）
// 使用：import { rod } from './serial.js';
// ═══════════════════════════════════════════════════════════════

export class FishingRod {
  constructor() {
    this.port = null;
    this.connected = false;
    this._buf = '';
  }

  /**
   * 请求并连接 Arduino 串口
   * 需要在用户手势事件（如点击按钮）内调用
   */
  async connect() {
    if (!('serial' in navigator)) {
      console.warn('[FishingRod] WebSerial 不支持，请使用 Chrome 89+ 并开启 experimental web platform features');
      return false;
    }
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 9600 });
      this.connected = true;
      console.log('[FishingRod] 已连接 Arduino');
      this._readLoop();
      return true;
    } catch (e) {
      console.warn('[FishingRod] 连接失败:', e.message);
      return false;
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (this.port) {
      await this.port.close();
      this.port = null;
      this.connected = false;
    }
  }

  /**
   * 发送指令到 Arduino
   * @param {string} cmd  例如 'FISH:carp' / 'CATCH' / 'STOP'
   */
  async send(cmd) {
    if (!this.connected || !this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(cmd + '\n'));
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * 触发某种鱼的震动序列
   * @param {'carp'|'grass'|'goldfish'|'mandarin'|'crab'|'dragon'|'bass'|'nian'|'shrimp'} fishType
   */
  async vibrateFish(fishType) {
    await this.send(`FISH:${fishType}`);
  }

  /**
   * 触发钓到鱼的庆祝震动
   */
  async vibrateCatch() {
    await this.send('CATCH');
  }

  /**
   * 停止所有震动
   */
  async stop() {
    await this.send('STOP');
  }

  // ─── 内部：持续读取 Arduino 上报的编码器 / 按钮值 ───────────────────
  async _readLoop() {
    if (!this.port?.readable) return;
    const decoder = new TextDecoderStream();
    this.port.readable.pipeTo(decoder.writable);
    const reader = decoder.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this._buf += value;
        const lines = this._buf.split('\n');
        this._buf = lines.pop(); // 保留不完整的行
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          // 处理编码器值：ENCODER:num（-100..100，保留旋钮方向）
          const encoderText = trimmed.startsWith('ENCODER:') ? trimmed.slice(8).trim() : trimmed;
          if (/^-?\d+$/.test(encoderText)) {
            const val = parseInt(encoderText, 10);
            if (!isNaN(val)) {
              const raw = Math.max(-100, Math.min(100, val));
              window.dispatchEvent(new CustomEvent('encoder-update', { 
                detail: {
                  raw,
                  value: raw,
                  abs: Math.abs(raw),
                  direction: raw === 0 ? 0 : (raw > 0 ? 1 : -1),
                }
              }));
            }
          }
          // 处理按钮按下事件：BTN:PRESS
          else if (trimmed.startsWith('BTN:')) {
            const btnType = trimmed.slice(4).trim();
            if (btnType === 'PRESS') {
              window.dispatchEvent(new CustomEvent('button-press', { 
                detail: { type: 'hook', timestamp: Date.now() }
              }));
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[FishingRod] 读取中断:', e.message);
    } finally {
      reader.releaseLock();
      this.connected = false;
    }
  }
}

// ─── 单例导出 ────────────────────────────────────────────────
export const rod = new FishingRod();

/*
──────────────────────────────────────────────────────────────
使用示例（在 app.js 中）：

  import { rod } from './serial.js';

  // 1. 在页面某个按钮点击事件内连接（必须有用户手势）
  document.getElementById('connect-btn').onclick = async () => {
    const ok = await rod.connect();
    if (ok) console.log('钓竿已连接');
  };

  // 2. 监听编码器旋转（钓线收/放）
  window.addEventListener('encoder-update', (e) => {
    const tension = e.detail; // 0-100（张力百分比）
    updateTensionMeter(tension);
    updateFishingLine(tension);
  });

  // 3. 监听钓竿按钮（尝试钓起）
  window.addEventListener('button-press', (e) => {
    if (e.detail.type === 'hook') {
      tryHookFish();
    }
  });

  // 4. 离开 FISHING 状态时
  rod.disconnect();

──────────────────────────────────────────────────────────────
启用 WebSerial（如报错）：
  地址栏输入: chrome://flags/#enable-experimental-web-platform-features
  → 开启 → 重启 Chrome
  Chrome 89+ 已默认支持，无需额外设置。

Arduino 编码器协议：
  发送 ENCODER:num\n  (num = -100..100，保留旋钮方向)
  发送 BTN:PRESS\n    (钓竿按钮按下事件)
──────────────────────────────────────────────────────────────
*/
