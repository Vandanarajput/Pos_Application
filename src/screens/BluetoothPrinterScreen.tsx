// src/screens/BluetoothPrinterScreen.tsx
// @ts-nocheck

// --- structuredClone polyfill (encoder safety) ---
if (typeof globalThis.structuredClone !== 'function') {
  // @ts-ignore
  globalThis.structuredClone = (obj) => {
    if (obj instanceof ArrayBuffer) return obj.slice(0);
    if (ArrayBuffer.isView(obj)) return obj.slice ? obj.slice() : new obj.constructor(obj);
    return JSON.parse(JSON.stringify(obj));
  };
}
// --------------------------------------------------

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Platform, PermissionsAndroid, Alert, ScrollView, TextInput,
  DeviceEventEmitter, TouchableOpacity, StyleSheet, AppState, Image
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import RNBluetoothClassic from 'react-native-bluetooth-classic';
import RNFS from 'react-native-fs';
import TcpSocket from 'react-native-tcp-socket';
import sampleReceiptJson from '../assets/txt.json';

const ReceiptPrinterEncoder =
  require('@point-of-sale/receipt-printer-encoder').default ??
  require('@point-of-sale/receipt-printer-encoder');

/* ============================================================
   🔹 ADD-ON 1: File logger (console -> file mirror, no logic change)
============================================================ */
const TS_PUBLIC_DIR =
  Platform.OS === 'android'
    ? `${RNFS.DownloadDirectoryPath}/Techsapphire`
    : `${RNFS.DocumentDirectoryPath}/Techsapphire`;

const TS_LOG_PATH = `${TS_PUBLIC_DIR}/app.log`;
const TS_PREF_PUBLIC_PATH = `${TS_PUBLIC_DIR}/printer_prefs.json`;
const TS_PREF_PRIVATE_PATH = `${RNFS.DocumentDirectoryPath}/printer_prefs.json`;

async function tsEnsureDir() {
  try { await RNFS.mkdir(TS_PUBLIC_DIR); } catch {}
}

async function tsMaybeAskLegacyStorageWrite() {
  if (Platform.OS !== 'android') return true;
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  if (api <= 28) {
    try {
      const ok = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE
      );
      return ok === PermissionsAndroid.RESULTS.GRANTED;
    } catch { return false; }
  }
  return true;
}

async function tsAppendLog(line) {
  try {
    await tsEnsureDir();
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${line}\n`;
    const exists = await RNFS.exists(TS_LOG_PATH);
    if (!exists) {
      await RNFS.writeFile(TS_LOG_PATH, text, 'utf8');
    } else {
      await RNFS.appendFile(TS_LOG_PATH, text, 'utf8');
    }
  } catch {
    // ignore logging failures
  }
}

// Monkey-patch console.* to also write into app.log
(() => {
  const _log = console.log?.bind(console);
  const _warn = console.warn?.bind(console);
  const _err = console.error?.bind(console);

  console.log = (...args) => {
    try { _log?.(...args); } catch {}
    try { tsAppendLog(`[LOG] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`); } catch {}
  };
  console.warn = (...args) => {
    try { _warn?.(...args); } catch {}
    try { tsAppendLog(`[WARN] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`); } catch {}
  };
  console.error = (...args) => {
    try { _err?.(...args); } catch {}
    try { tsAppendLog(`[ERROR] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`); } catch {}
  };
})();

// First-run: note where logs go
tsAppendLog('=== Techsapphire logger online ===');
tsAppendLog(`Log file: ${TS_LOG_PATH}`);
tsAppendLog(`Prefs (private): ${TS_PREF_PRIVATE_PATH}`);
tsAppendLog(`Prefs (public copy): ${TS_PREF_PUBLIC_PATH}`);

/* ============================================================
   🔹 ADD-ON 2: Mirror prefs to visible folder (no logic change)
============================================================ */
const __origWriteFile = RNFS.writeFile?.bind(RNFS);
RNFS.writeFile = async (path, contents, enc = 'utf8') => {
  const result = await __origWriteFile(path, contents, enc);
  // If we just wrote the private prefs, mirror it to public path
  try {
    if (path === TS_PREF_PRIVATE_PATH) {
      if (Platform.OS === 'android') {
        const perm = await tsMaybeAskLegacyStorageWrite();
        if (!perm) {
          tsAppendLog('Mirror prefs skipped: no WRITE permission (Android <= 9).');
          return result;
        }
      }
      await tsEnsureDir();
      await RNFS.writeFile(TS_PREF_PUBLIC_PATH, contents, 'utf8');
      tsAppendLog(`Prefs mirrored to: ${TS_PREF_PUBLIC_PATH}`);
    }
  } catch (e) {
    tsAppendLog(`Prefs mirror error: ${String(e?.message || e)}`);
  }
  return result;
};

// On boot, if private prefs already exist, mirror once to public path
(async () => {
  try {
    const exists = await RNFS.exists(TS_PREF_PRIVATE_PATH);
    if (exists) {
      if (Platform.OS === 'android') {
        const perm = await tsMaybeAskLegacyStorageWrite();
        if (!perm) {
          tsAppendLog('Startup prefs mirror skipped: no WRITE permission (Android <= 9).');
          return;
        }
      }
      await tsEnsureDir();
      const txt = await RNFS.readFile(TS_PREF_PRIVATE_PATH, 'utf8');
      await RNFS.writeFile(TS_PREF_PUBLIC_PATH, txt, 'utf8');
      tsAppendLog('Startup prefs mirrored to public folder.');
    } else {
      tsAppendLog('No private prefs yet; will mirror on first save.');
    }
  } catch (e) {
    tsAppendLog(`Startup mirror error: ${String(e?.message || e)}`);
  }
})();

/* ============================================================
   Your existing code continues below (unchanged logic)
   + small LOCAL LOGO helper (folder asset -> base64)
============================================================ */

// --- LOCAL LOGO from folder (no JSON needed) ---
const LOCAL_LOGO = require('../assets/logo.png'); // change to logo.png if needed

const tryGetLocalLogoBase64 = async (): Promise<string | null> => {
  try {
    const src = Image.resolveAssetSource(LOCAL_LOGO);
    const uri = src?.uri || '';

    // Preferred: read file:// path
    if (uri.startsWith('file://')) {
      const b64 = await RNFS.readFile(uri.replace('file://', ''), 'base64');
      if (b64?.length > 800) { console.log('[logo] read from file://'); return b64; } // 🔧 CHANGE (log)
    }

    // Android "asset:/" fallback
    if (Platform.OS === 'android') {
      const assetName = (uri.startsWith('asset:/') && uri.replace('asset:/', '')) || 'logo.png';
      try {
        const b64 = await RNFS.readFileAssets(assetName, 'base64');
        if (b64?.length > 800) { console.log('[logo] read from assets:/', assetName); return b64; } // 🔧 CHANGE (log)
      } catch {}
    }

    // Last resort: try reading the raw uri
    if (uri) {
      try {
        const b64 = await RNFS.readFile(uri, 'base64');
        if (b64?.length > 800) { console.log('[logo] read from uri'); return b64; } // 🔧 CHANGE (log)
      } catch {}
    }
  } catch {}
  console.warn('[logo] local asset not found or too small'); // 🔧 CHANGE (log)
  return null;
};

// ===== Helpers (shared) =====
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const bytesToBinaryString = (bytes: Uint8Array) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 0xff);
  return out;
};
const writeChunked = async (dev: any, bytes: Uint8Array, chunk = 256) => {
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.slice(i, Math.min(i + chunk, bytes.length));
    await dev.write(bytesToBinaryString(slice));
  }
};
const toBase64 = (bytes: Uint8Array) => {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = ''; let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += table[(n >>> 18) & 63] + table[(n >>> 12) & 63] + table[(n >>> 6) & 63] + table[n & 63];
  }
  if (i < bytes.length) {
    let n = bytes[i] << 16;
    out += table[(n >>> 18) & 63] + table[(n >>> 12) & 63];
    if (i + 1 < bytes.length) { n |= bytes[i + 1] << 8; out += table[(n >>> 6) & 63] + '='; }
    else out += '==';
  }
  return out;
};
const sendWithFallbacks = async (dev: any, address: string, ascii: string, bytes: Uint8Array) => {
  if (typeof RNBluetoothClassic.writeToDevice === 'function') {
    try { await RNBluetoothClassic.writeToDevice(ascii, address); return; } catch {}
  }
  if (dev?.write) {
    try { await writeChunked(dev, bytes, 256); return; } catch {}
  }
  const b64 = toBase64(bytes);
  if (typeof RNBluetoothClassic.writeToDevice === 'function') {
    await RNBluetoothClassic.writeToDevice(b64, address); return;
  }
  if (dev?.write) { // @ts-ignore
    await dev.write(b64, { encoding: 'base64' }); return;
  }
  throw new Error('No supported write method');
};

// ---------- text layout + image helpers ----------
const wrapText = (text: string, max: number) => {
  const out: string[] = []; let s = text || '';
  while (s.length > max) { out.push(s.slice(0, max)); s = s.slice(max); }
  if (s.length) out.push(s);
  return out;
};
const stripDataUri = (b64: string = '') => b64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();

const decodeBase64 = (b64: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const clean = stripDataUri(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = []; let i = 0;
  while (i < clean.length) {
    const c1 = alphabet.indexOf(clean[i++]); const c2 = alphabet.indexOf(clean[i++]);
    const c3 = alphabet.indexOf(clean[i++]); const c4 = alphabet.indexOf(clean[i++]);
    const n = (c1 << 18) | (c2 << 12) | ((c3 & 63) << 6) | (c4 & 63);
    if (c3 !== 64) bytes.push((n >> 16) & 255);
    if (c4 !== 64) bytes.push((n >> 8) & 255);
    if (c4 !== 64) bytes.push(n & 255);
  }
  return new Uint8Array(bytes);
};
const lineLR = (w: number, L: string, R: string) => {
  const left = (L ?? '').toString(); const right = (R ?? '').toString();
  const spaces = Math.max(1, w - left.length - right.length);
  return left + ' '.repeat(spaces) + right;
};
const money = (n: number) => Number(n || 0).toFixed(2);

// ---------- build receipt bytes ----------
const buildReceiptBytes = (data: {
  width?: number;
  logoBase64?: string;
  shopName: string;
  headerLines?: string[];
  phone?: string;
  items: Array<{ name: string; qty: number; price: number }>;
  thankYou?: string;
  summary?: Array<{ key: string; value: string | number }>;
  footers?: Array<{ text: string; align?: 'left'|'center'|'right' }>;
}) => {
  const width = data.width ?? 32;
  const enc = new ReceiptPrinterEncoder();

  enc.initialize().codepage('cp437');

  const preferredDots = width > 38 ? 576 : 384; // ~80mm vs ~58mm
  const clamp8 = (n: number) => n - (n % 8);

  // 🔧 CHANGE: reserve space if logo can’t print
  const reserveLogoLines = width > 38 ? 12 : 10; // tune as you like
  let logoPrinted = false; // track success

  if (data.logoBase64) {
    const b64 = stripDataUri(data.logoBase64);
    if (!b64 || b64.length < 800) {
      console.warn('[logo] base64 missing/too small, len=', b64?.length || 0);
    } else {
      const imgBytes = decodeBase64(b64);
      let ok = false;
      for (let w = clamp8(preferredDots); w >= 128; w -= 8) {
        try {
          enc.align('center') // <- change alignment here for the logo if needed
            .image(imgBytes, 'threshold', w)
            .newline(); ok = true; break;
        } catch (e1) {
          try { enc.align('center').image(imgBytes, 'dither', w).newline(); ok = true; break; }
          catch (e2) {
            try { enc.align('center').image(imgBytes, 'bitImageColumn', w).newline(); ok = true; break; }
            catch (e3) {}
          }
        }
      }
      if (ok) { console.log('[logo] printed'); logoPrinted = true; } // 🔧 CHANGE
    }
  }

  // 🔧 CHANGE: if logo didn’t print, keep the header layout stable
  if (!logoPrinted) {
    for (let i = 0; i < reserveLogoLines; i++) enc.newline();
    console.warn('[logo] not printed; reserved', reserveLogoLines, 'lines');
  }

  enc.align('center').bold(true).line(data.shopName || 'RECEIPT').bold(false); // <- shop name alignment
  (data.headerLines || []).forEach(l => enc.line(l));
  if (data.phone) enc.line(`Tel: ${data.phone}`);
  enc.newline();

  enc.align('left').line('-'.repeat(width));
  enc.line(lineLR(width, 'Item', 'Qty   Price'));
  enc.line('-'.repeat(width));

  const wrapLimit = 30;
  const itemsTotal = (data.items || []).reduce((s, it) => s + (Number(it.qty)||0)*(Number(it.price)||0), 0);

  (data.items || []).forEach(it => {
    const name = String(it.name || '');
    wrapText(name, wrapLimit).forEach((chunk, idx) => {
      if (idx === 0) {
        const qtyStr = String(it.qty ?? 0).padStart(3);
        const total  = money((Number(it.qty)||0) * (Number(it.price)||0));
        enc.line(lineLR(width, chunk, `${qtyStr}  ${total}`));
      } else enc.line(chunk);
    });
  });

  enc.line('-'.repeat(width));

  if (Array.isArray(data.summary) && data.summary.length > 0) {
    data.summary.forEach(r => enc.line(lineLR(width, String(r.key ?? ''), String(r.value ?? ''))));
  } else {
    enc.bold(true).line(lineLR(width, 'TOTAL', money(itemsTotal))).bold(false);
  }

  enc.newline();

  if (Array.isArray(data.footers)) {
    data.footers.forEach(f => {
      const a = (f.align || 'left').toLowerCase();
      if (a === 'center') enc.align('center').line(f.text || '');
      else if (a === 'right') enc.align('right').line(f.text || '');
      else enc.align('left').line(f.text || '');
    });
    enc.newline();
  }

  enc.align('center').line(data.thankYou || 'Thank you!');
  enc.newline().newline().newline().newline().newline();
  enc.cut('full');

  return enc.encode();
};



// ---------- parse your JSON ----------
const parseEsmartPosJson = (jsonString: string) => {
  let root: any; try { root = JSON.parse(jsonString); } catch { throw new Error('Invalid JSON'); }
  const width = Number(root.item_length || 32) || 32;

  const header = (root.data || []).find((b: any) => b?.type?.toLowerCase() === 'header')?.data || {};
  const shopName = header.top_title || 'RECEIPT';
  const logoBase64 = header.logo_base64 || header.logoBase64 || header.base64 || header.logo_base || '';

  const headerLines: string[] = [];
  if (Array.isArray(header.sub_titles)) headerLines.push(...header.sub_titles);
  if (Array.isArray(header.address) && header.address.length) headerLines.push(header.address[0]);

  const phone = (Array.isArray(header.sub_titles) && header.sub_titles.find((s: string) => /\d{7,}/.test(String(s)))) || '';

  const itemBlock = (root.data || []).find((b: any) => b?.type?.toLowerCase() === 'item')?.data || {};
  const rows: any[] = Array.isArray(itemBlock.itemdata) ? itemBlock.itemdata : [];
  const items = rows.map((it) => {
    const qty = Number(it.quantity || 0) || 0;
    const lineTotal = Number(it.item_amount || it.total || 0) || 0;
    const price = qty > 0 ? lineTotal / qty : 0;
    return { name: String(it.item_name || it.name || 'Item'), qty, price };
  });

  let summary: Array<{ key: string; value: string | number }> = [];
  const summaryBlock = (root.data || []).find((b: any) => String(b?.type || '').toLowerCase().includes('bigsummary'))?.data;
  if (summaryBlock) {
    if (Array.isArray(summaryBlock.rows)) summary = summaryBlock.rows.map((r: any) => ({ key: String(r.key || ''), value: r.value ?? '' }));
    else if (Array.isArray(summaryBlock.keys) && Array.isArray(summaryBlock.values)) {
      const n = Math.min(summaryBlock.keys.length, summaryBlock.values.length);
      for (let i = 0; i < n; i++) summary.push({ key: String(summaryBlock.keys[i]), value: summaryBlock.values[i] });
    } else if (summaryBlock.summary && typeof summaryBlock.summary === 'object') {
      Object.entries(summaryBlock.summary).forEach(([k, v]) => summary.push({ key: String(k), value: v as any }));
    }
  }

  const footers: Array<{ text: string, align?: 'left' | 'center' | 'right' }> = [];
  (root.data || []).forEach((b: any) => {
    if (String(b?.type || '').toLowerCase() === 'footer') {
      const d = b.data || {};
      if (Array.isArray(d.footer_text)) {
        d.footer_text.forEach((line: any) => {
          if (typeof line === 'string') footers.push({ text: line, align: (d.align || 'left') });
          else if (line && typeof line === 'object') footers.push({ text: String(line.text || ''), align: (line.align || 'left') });
        });
      } else if (typeof d === 'object' && d.text) {
        footers.push({ text: String(d.text), align: (d.align || 'left') });
      }
    }
  });

  const thankYou = (root.thankYou || root.thanks || 'Thank you!');

  return { width, logoBase64, shopName, headerLines, phone, items, summary, footers, thankYou, __root: root };
};

// download URL -> base64 (used for both BT & Network)
const loadImageUrlToBase64 = async (url: string) => {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || 'jpg';
  const dest = `${RNFS.CachesDirectoryPath}/receipt_logo.${ext}`;
  const dl = RNFS.downloadFile({ fromUrl: url, toFile: dest, background: true });
  const res = await dl.promise;
  if (!res || (res.statusCode && res.statusCode >= 400)) throw new Error(`HTTP ${res?.statusCode || '??'}`);
  const b64 = await RNFS.readFile(dest, 'base64');

  const head = (b64 || '').slice(0, 32);
  const looksPng = head.startsWith('iVBORw0KGgo');
  const looksJpg = head.startsWith('/9j/');
  if (!looksPng && !looksJpg) throw new Error('Downloaded file is not a PNG/JPG image');

  if (!b64 || b64.length < 800) throw new Error('Downloaded image too small');
  return b64;
};

// normalize + (maybe) fetch logo from URL
const buildBytesFromJson = async (jsonString: string) => {
  const data = parseEsmartPosJson(jsonString);

  const tinyBase64 = (b64?: string) => !b64 || stripDataUri(b64).length < 500;
  const logoUrl = (data.__root?.data || []).find((b: any) => String(b?.type || '').toLowerCase() === 'logo')?.data?.url;

  // Prefer LOCAL asset if JSON didn't include a good base64
  if (tinyBase64(data.logoBase64)) {
    try {
      const localB64 = await tryGetLocalLogoBase64();
      if (localB64) {
        data.logoBase64 = localB64;
        console.log('[logo] using local asset base64, len=', localB64.length);
      } else {
        console.warn('[logo] no local asset available'); // 🔧 CHANGE (log)
      }
    } catch {}
  }

  if (logoUrl && tinyBase64(data.logoBase64)) {
    try {
      const downloaded = await loadImageUrlToBase64(logoUrl);
      console.log('[logo] downloaded ok, len=', downloaded.length);
      data.logoBase64 = downloaded;
    } catch (e: any) {
      console.warn('[logo] download failed:', e?.message || String(e));
    }
  } else {
    console.log('[logo] using embedded base64, len=', stripDataUri(data.logoBase64)?.length || 0);
  }

  return buildReceiptBytes(data);
};

/* ---------------------------
   PERSISTENCE (tiny, no new libs)
----------------------------*/
const PREF_FILE = `${RNFS.DocumentDirectoryPath}/printer_prefs.json`;

const readPrefs = async () => {
  try {
    const exists = await RNFS.exists(PREF_FILE);
    if (!exists) return {};
    const txt = await RNFS.readFile(PREF_FILE, 'utf8');
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
};
const writePrefs = async (partial) => {
  try {
    const curr = await readPrefs();
    const next = { ...curr, ...partial };
    await RNFS.writeFile(PREF_FILE, JSON.stringify(next), 'utf8');
  } catch {}
};

// ===== Component =====
export default function BluetoothPrinterScreen() {
  // --------- BLUETOOTH state ----------
  const [devices, setDevices] = useState<Array<{ id?: string; address?: string; name?: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [connected, setConnected] = useState(false);
  const [activeAddress, setActiveAddress] = useState<string | undefined>();
  const deviceRef = useRef<any>(null);
  const listenerRef = useRef<any>(null);

  // --------- 🌐 NETWORK state ----------
  const [ip, setIp] = useState('192.168.0.100');
  const [netConnected, setNetConnected] = useState(false);
  const socketRef = useRef<any>(null);

  // (internal only – not shown)
  const [savedBtName, setSavedBtName] = useState<string | undefined>();
  const [savedBtAddress, setSavedBtAddress] = useState<string | undefined>();
  const [savedIp, setSavedIp] = useState<string | undefined>();

  // live refs (for event listener)
  const connectedRef = useRef(false);
  const netConnectedRef = useRef(false);
  const addressRef = useRef<string | undefined>(undefined);

  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { netConnectedRef.current = netConnected; }, [netConnected]);
  useEffect(() => { addressRef.current = activeAddress; }, [activeAddress]);

  const api =
    Platform.OS === 'android'
      ? (typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10)) || 0
      : 0;

  // ===== Bluetooth discovery/connection =====
  const ensureAdapterOn = async () => {
    try { const enabled = await RNBluetoothClassic.isBluetoothEnabled?.(); if (!enabled) await RNBluetoothClassic.requestEnabled?.(); } catch {}
  };
  const ensureScanPermissions = async () => {
    if (Platform.OS !== 'android') return true;
    const ask = async (perm?: string) => { if (!perm) return true; const res = await PermissionsAndroid.request(perm); return res === PermissionsAndroid.RESULTS.GRANTED; };
    if (api >= 31) {
      const okScan = await ask(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
      const okConnect = await ask(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      return okScan && okConnect;
    } else {
      const okLoc = await ask(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      return okLoc;
    }
  };
  const mergeIn = (curr: typeof devices, extra: any[]) => {
    const map = new Map<string, { id?: string; address?: string; name?: string }>();
    curr.forEach(d => map.set((d.id ?? d.address) as string, d));
    extra.forEach((d: any) => { const key = d?.id ?? d?.address; if (key) map.set(key, { id: d.id, address: d.address, name: d.name }); });
    return [...map.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  };
  const startDiscovery = async () => {
    const ok = await ensureScanPermissions();
    if (!ok) return;
    try {
      try { await RNBluetoothClassic.cancelDiscovery?.(); } catch {}
      const bonded = (await RNBluetoothClassic.getBondedDevices?.()) ?? [];
      setDevices(prev => mergeIn(prev, bonded));
      if (!selectedId && bonded.length) setSelectedId(bonded[0].id ?? bonded[0].address);
      try { listenerRef.current?.remove?.(); } catch {}
      listenerRef.current =
        RNBluetoothClassic.onDeviceDiscovered?.((d: any) => {
          setDevices(prev => mergeIn(prev, [d]));
          if (!selectedId) setSelectedId(d?.id ?? d?.address);
        }) ??
        RNBluetoothClassic.addListener?.('deviceDiscovered', (d: any) => {
          setDevices(prev => mergeIn(prev, [d]));
          if (!selectedId) setSelectedId(d?.id ?? d?.address);
        });

      const discovered = (await RNBluetoothClassic.startDiscovery?.()) ?? [];
      setDevices(prev => mergeIn(prev, discovered));
      if (!selectedId && discovered.length) setSelectedId(discovered[0].id ?? discovered[0].address);
    } catch (e: any) {
      console.warn('startDiscovery error:', e?.message ?? String(e));
    } finally {
      try { await RNBluetoothClassic.cancelDiscovery?.(); } catch {}
    }
  };

  // ---- ONE-SHOT auto reconnect on mount (no timer) ----
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      if (cancelled) return;

      await ensureAdapterOn();

      const prefs = await readPrefs().catch(() => ({}));
      if (prefs?.ip && typeof prefs.ip === 'string') {
        setIp(prefs.ip);
        setSavedIp(prefs.ip);
      }
      if (prefs?.btAddress) {
        setSavedBtAddress(prefs.btAddress);
        if (prefs?.btName) setSavedBtName(prefs.btName);
      }

      await startDiscovery();

      // Try network auto-connect once
      if (prefs?.ip && !netConnectedRef.current) {
        try {
          const s = TcpSocket.createConnection({ port: 9100, host: prefs.ip, tls: false }, () => {
            setNetConnected(true);
            socketRef.current = s;
          });
          s.on('error', () => { try { s.destroy(); } catch {} });
        } catch {}
      }

      // Try BT auto-reconnect (few quick retries inline)
      if (prefs?.btAddress && typeof prefs.btAddress === 'string' && !connectedRef.current) {
        setSelectedId(prefs.btAddress);
        for (let i = 0; i < 5 && !connectedRef.current; i++) {
          try {
            let conn = null;
            try { conn = await RNBluetoothClassic.connectToDevice(prefs.btAddress, { CONNECTOR_TYPE: 'rfcomm', secure: false }); } catch {}
            if (!conn) { conn = await RNBluetoothClassic.connectToDevice(prefs.btAddress, { CONNECTOR_TYPE: 'rfcomm', secure: true }); }
            if (conn) {
              deviceRef.current = conn;
              setActiveAddress(prefs.btAddress);
              setConnected(true);
              break;
            }
          } catch {}
          await sleep(500);
        }
      }
    };

    boot();
    return () => {
      cancelled = true;
      try { listenerRef.current?.remove?.(); } catch {}
      try { RNBluetoothClassic.cancelDiscovery?.(); } catch {}
      try { deviceRef.current?.disconnect(); } catch {}
      try { socketRef.current?.destroy(); } catch {}
    };
  }, []);

  // ---- Foreground one-shot retry (not a timer) ----
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (st) => {
      if (st !== 'active') return;
      try {
        const prefs = await readPrefs();
        // If BT not connected, try once
        if (!connectedRef.current && prefs?.btAddress) {
          try {
            let conn = null;
            try { conn = await RNBluetoothClassic.connectToDevice(prefs.btAddress, { CONNECTOR_TYPE: 'rfcomm', secure: false }); } catch {}
            if (!conn) { conn = await RNBluetoothClassic.connectToDevice(prefs.btAddress, { CONNECTOR_TYPE: 'rfcomm', secure: true }); }
            if (conn) {
              deviceRef.current = conn;
              setActiveAddress(prefs.btAddress);
              setConnected(true);
            }
          } catch {}
        }
        // If NET not connected, try once
        if (!netConnectedRef.current && prefs?.ip && !socketRef.current) {
          try {
            const s = TcpSocket.createConnection({ port: 9100, host: prefs.ip, tls: false }, () => {
              setNetConnected(true);
              socketRef.current = s;
            });
            s.on('error', () => { try { s.destroy(); } catch {} });
          } catch {}
        }
      } catch {}
    });
    return () => sub.remove();
  }, []);

  const connectOrDisconnect = async () => {
    if (connectedRef.current) {
      try { await deviceRef.current?.disconnect?.(); } catch {}
      try { if (addressRef.current) await RNBluetoothClassic.disconnectFromDevice?.(addressRef.current); } catch {}
      deviceRef.current = null; setActiveAddress(undefined); setConnected(false); return;
    }
    if (!selectedId) { Alert.alert('Select a device', 'Choose a device from the list.'); return; }
    try {
      try { await RNBluetoothClassic.cancelDiscovery?.(); } catch {}
      const bonded = (await RNBluetoothClassic.getBondedDevices?.()) ?? [];
      const discovered = (await RNBluetoothClassic.getDiscoveredDevices?.()) ?? [];
      const all = [...bonded, ...discovered];
      const target = all.find((d) => (d.id ?? d.address) === selectedId);
      if (!target) { Alert.alert('Not found', 'Device not available right now.'); return; }
      const address = target.address ?? target.id; if (!address) throw new Error('Device has no address');
      let conn = null;
      try { conn = await RNBluetoothClassic.connectToDevice(address, { CONNECTOR_TYPE: 'rfcomm', secure: false }); } catch {}
      if (!conn) { conn = await RNBluetoothClassic.connectToDevice(address, { CONNECTOR_TYPE: 'rfcomm', secure: true }); }
      if (!conn) throw new Error('Connect failed');
      deviceRef.current = conn; setActiveAddress(address); setConnected(true);

      // save for next launch
      await writePrefs({ btAddress: address, btName: target.name || '' });
      setSavedBtAddress(address);
      setSavedBtName(target.name || '');

      await sleep(300);
      Alert.alert('Connected', target.name ?? address);
    } catch (e: any) {
      setConnected(false); setActiveAddress(undefined); Alert.alert('Connect error', e?.message ?? String(e));
    }
  };
  const quickReconnect = async (address: string) => {
    try { await RNBluetoothClassic.cancelDiscovery?.(); } catch {}
    await sleep(150);
    try {
      let conn = null;
      try { conn = await RNBluetoothClassic.connectToDevice(address, { CONNECTOR_TYPE: 'rfcomm', secure: false }); } catch {}
      if (!conn) { conn = await RNBluetoothClassic.connectToDevice(address, { CONNECTOR_TYPE: 'rfcomm', secure: true }); }
      if (!conn) throw new Error('Reconnect failed');
      deviceRef.current = conn; setConnected(true); await sleep(200); return true;
    } catch { return false; }
  };

  const testPrint = async () => {
    const address = addressRef.current;
    if (!connectedRef.current || !address) { Alert.alert('Not connected', 'Connect to a printer first.'); return; }
    const trySend = async () => {
      try { await RNBluetoothClassic.cancelDiscovery?.(); } catch {}
      await sleep(120);
      const bytes = await buildBytesFromJson(JSON.stringify(sampleReceiptJson));
      const ascii = bytesToBinaryString(bytes);
      await sendWithFallbacks(deviceRef.current, address, ascii, bytes);
    };
    try {
      await trySend();
      Alert.alert('Printed', 'Receipt sent via Bluetooth.');
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).toLowerCase();
      if (msg.includes('not connected')) {
        const ok = await quickReconnect(address);
        if (ok) { try { await trySend(); Alert.alert('Printed', 'Receipt sent after reconnect.'); return; } catch (e2: any) { Alert.alert('Print error', e2?.message ?? String(e2)); return; } }
      }
      Alert.alert('Print error', e?.message ?? String(e));
    }
  };

  // ===== 🌐 NETWORK: connect / print over TCP (port 9100) =====
  const connectOrDisconnectNet = async () => {
    if (netConnectedRef.current) {
      try { socketRef.current?.destroy(); } catch {}
      socketRef.current = null;
      setNetConnected(false);
      return;
    }
    if (!ip.trim()) { Alert.alert('Enter IP', 'Type your printer IP address.'); return; }

    try {
      const socket = TcpSocket.createConnection({ port: 9100, host: ip, tls: false }, async () => {
        setNetConnected(true);
        socketRef.current = socket;

        // save IP for next launch
        await writePrefs({ ip });

        Alert.alert('Connected', `Network printer: ${ip}`);
      });

      socket.on('error', (err: any) => {
        setNetConnected(false);
        Alert.alert('Network error', err?.message || String(err));
      });

    } catch (e: any) {
      setNetConnected(false);
      Alert.alert('Connect error', e?.message ?? String(e));
    }
  };

  const testPrintNet = async () => {
    if (!netConnectedRef.current || !socketRef.current) {
      Alert.alert('Not connected', 'Connect to the network printer first.');
      return;
    }
    try {
      const bytes = await buildBytesFromJson(JSON.stringify(sampleReceiptJson));
      const ascii = bytesToBinaryString(bytes); // send as binary string over TCP
      socketRef.current.write(ascii);
      Alert.alert('Printed', 'Receipt sent via Network.');
    } catch (e: any) {
      Alert.alert('Print error', e?.message ?? String(e));
    }
  };

  // 🔻 LISTEN: event-driven printing from App/WebView (PRINT_JSON)
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PRINT_JSON', async (payload) => {
      try {
        const jsonString = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const bytes = await buildBytesFromJson(jsonString);
        const ascii = bytesToBinaryString(bytes);

        if (netConnectedRef.current && socketRef.current) {
          try { socketRef.current.write('\x1b@'); } catch {}
          await sleep(80);
          socketRef.current.write(ascii);
          Alert.alert('Printed', 'Receipt sent via Network.');
          return;
        }

        if (connectedRef.current && addressRef.current) {
          try { await RNBluetoothClassic.cancelDiscovery?.(); } catch {}
          await sleep(150);
          try {
            if (deviceRef.current?.write) { await deviceRef.current.write('\x1b@'); }
            else if (typeof RNBluetoothClassic.writeToDevice === 'function') {
              await RNBluetoothClassic.writeToDevice('\x1b@', addressRef.current);
            }
          } catch {}
          await sleep(50);
          await sendWithFallbacks(deviceRef.current, addressRef.current, ascii, bytes);
          Alert.alert('Printed', 'Receipt sent via Bluetooth.');
          return;
        }

        Alert.alert('Printer not connected');
      } catch (err: any) {
        Alert.alert('Print error', err?.message ?? String(err));
      }
    });

    return () => sub?.remove?.();
  }, []); // mount once

  // ===== UI (Drawer) =====
  const RoundButton = ({ title, onPress, disabled }: any) => (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.roundBtn, disabled && styles.roundBtnDisabled]}
      activeOpacity={0.7}
    >
      <Text style={styles.roundBtnText}>{title}</Text>
    </TouchableOpacity>
  );

  const connectionSummary =
    connected && netConnected
      ? 'Bluetooth + Network connected'
      : connected
      ? 'Bluetooth connected'
      : netConnected
      ? 'Network connected'
      : 'Disconnected';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.h1}>Bluetooth Printer</Text>

      {/* (No saved device/IP shown in UI, per your request) */}

      <Text style={styles.label}>Select Device</Text>
      <View style={styles.pickerWrap}>
        <Picker
          selectedValue={selectedId}
          onValueChange={(v) => setSelectedId(String(v))}
          dropdownIconColor="#7E6AA6"
        >
          {devices.length === 0 ? (
            <Picker.Item label="Searching for devices..." value="" />
          ) : (
            devices.map((d) => (
              <Picker.Item
                key={(d.id ?? d.address) as string}
                label={`${d.name ?? 'Unknown'} (${d.address ?? d.id})`}
                value={(d.id ?? d.address) as string}
              />
            ))
          )}
        </Picker>
      </View>

      <RoundButton
        title={connected ? 'Disconnect from Bluetooth' : 'Connect to Bluetooth'}
        onPress={connectOrDisconnect}
        disabled={!connected && !selectedId}
      />
      <RoundButton
        title="Print Demo Text (Bluetooth)"
        onPress={testPrint}
        disabled={!connected}
      />

      <View style={styles.divider} />

      <Text style={styles.h2}>Network Printer</Text>

      <Text style={styles.smallLabel}>IP Address</Text>
      <TextInput
        placeholder="192.168.1.80"
        value={ip}
        onChangeText={setIp}
        autoCapitalize="none"
        keyboardType="numeric"
        style={styles.input}
        placeholderTextColor="#9aa"
      />

      <Text style={styles.smallLabel}>Port</Text>
      <TextInput
        value="9100"
        editable={false}
        style={[styles.input, { color: '#111' }]}
      />

      <RoundButton
        title={netConnected ? 'Disconnect from Network Printer' : 'Connect to Network Printer'}
        onPress={connectOrDisconnectNet}
      />
      <RoundButton
        title="Print Demo Text (Network)"
        onPress={testPrintNet}
        disabled={!netConnected}
      />

      <Text style={styles.status}>
        Status{' '}
        <Text style={{ fontWeight: '700' }}>
          {connectionSummary}
        </Text>
      </Text>

      {Platform.OS === 'ios' && (
        <Text style={styles.iosNote}>
          iOS note: generic SPP Bluetooth won’t show; network printing works on both.
        </Text>
      )}
    </ScrollView>
  );
}

/* ---------- styles (UI only) ---------- */
const styles = StyleSheet.create({
  scroll: { backgroundColor: 'transparent' },
  container: { padding: 20, paddingBottom: 32, backgroundColor: 'transparent' },
  h1: { fontSize: 26, fontWeight: '700', color: '#111', marginBottom: 12 },
  h2: { fontSize: 22, fontWeight: '700', color: '#111', marginTop: 8, marginBottom: 8 },
  label: { fontSize: 18, fontWeight: '700', color: '#5C4B7D', marginTop: 6, marginBottom: 6 },
  smallLabel: { fontSize: 12, color: '#7A7A8A', marginTop: 10, marginBottom: 4 },
  pickerWrap: { borderBottomWidth: 1, borderBottomColor: '#E5DFF0', marginBottom: 14 },
  roundBtn: {
    backgroundColor: 'transparent',
    borderRadius: 26,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#E6DFF3',
    shadowOpacity: 0,
    elevation: 0,
  },
  roundBtnDisabled: { opacity: 0.5 },
  roundBtnText: { color: '#6C56A4', fontWeight: '700', fontSize: 16 },
  input: {
    borderBottomWidth: 2,
    borderBottomColor: '#D7CEE9',
    paddingVertical: 8,
    fontSize: 18,
    color: '#111',
    marginBottom: 8,
    backgroundColor: 'transparent',
  },
  divider: { height: 1, backgroundColor: '#E6DFF3', marginVertical: 14 },
  status: { marginTop: 16, fontSize: 18, color: '#222' },
  iosNote: { color: '#c00', marginTop: 12 },
});
