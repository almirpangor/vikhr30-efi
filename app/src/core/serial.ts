// Транспорт через Web Serial (COM-порт: USB-UART или Bluetooth SPP), 115200 8N1.
import type { Transport } from './protocol';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const serialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator;

export class SerialTransport implements Transport {
  onData: ((chunk: string) => void) | null = null;
  onClose: (() => void) | null = null;
  name = 'COM-порт';
  private writer: any;
  private reader: any;
  private closing = false;
  private enc = new TextEncoder();

  private constructor(private port: any) {}

  /** Показать системный список портов и открыть выбранный. */
  static async open(): Promise<SerialTransport> {
    const serial = (navigator as any).serial;
    const port = await serial.requestPort();
    await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    const t = new SerialTransport(port);
    const info = port.getInfo?.() ?? {};
    t.name = info.usbVendorId ? `USB-UART ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}` : info.bluetoothServiceClassId ? 'Bluetooth' : 'COM-порт';
    t.writer = port.writable.getWriter();
    t.readLoop();
    return t;
  }

  private async readLoop() {
    const dec = new TextDecoder('utf-8', { fatal: false });
    try {
      while (!this.closing && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onData?.(dec.decode(value, { stream: true }));
          }
        } catch {
          // ошибки кадра/переполнения: поток пересоздаётся на следующем витке
        } finally {
          try { this.reader.releaseLock(); } catch { /* уже освобождён */ }
        }
        if (this.closing) break;
      }
    } finally {
      if (!this.closing) { this.closing = true; try { await this.port.close(); } catch { /* порт уже пропал */ } this.onClose?.(); }
    }
  }

  async write(data: string) {
    if (this.closing) throw new Error('порт закрыт');
    await this.writer.write(this.enc.encode(data));
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* нет активного чтения */ }
    try { this.writer?.releaseLock(); } catch { /* уже освобождён */ }
    try { await this.port.close(); } catch { /* порт уже закрыт */ }
  }
}
