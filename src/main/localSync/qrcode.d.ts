// The one function used from `qrcode` (which ships no types). Referenced
// from protocol.ts with a triple-slash directive so the node and test
// tsconfigs both see it.
declare module 'qrcode' {
  interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number
    width?: number
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
}
