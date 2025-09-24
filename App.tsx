// App.tsx
// @ts-nocheck

import 'react-native-gesture-handler'; // keep this at the very top

import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  Button,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
  SafeAreaView,
  FlatList,
  Alert,
  DeviceEventEmitter, // for sending/receiving events
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator, DrawerContentScrollView } from '@react-navigation/drawer';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import WebView from 'react-native-webview';

// 👉 your existing screen
import BluetoothPrinterScreen from './src/screens/BluetoothPrinterScreen';

// ⬇️ Reads app version (no new library needed)
const { version: APP_VERSION } = require('./package.json');

const Drawer = createDrawerNavigator();

/* ------------------------------------------------------------------
   🔸 Minimal persistence (same file as printer screen uses)
   - Stores URL at RNFS.DocumentDirectoryPath/printer_prefs.json
   - Keeps existing keys (ip, btAddress, etc.) and just adds "webUrl"
------------------------------------------------------------------- */
import RNFS from 'react-native-fs';

const PREF_FILE = `${RNFS.DocumentDirectoryPath}/printer_prefs.json`;

async function readPrefs() {
  try {
    const exists = await RNFS.exists(PREF_FILE);
    if (!exists) return {};
    const txt = await RNFS.readFile(PREF_FILE, 'utf8');
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}
async function writePrefs(partial) {
  try {
    const curr = await readPrefs();
    const next = { ...curr, ...partial };
    await RNFS.writeFile(PREF_FILE, JSON.stringify(next), 'utf8');
  } catch {}
}

/** Home screen with in-app WebView */
function HomeScreen({ webUrl, setWebUrl, onReceipt, latestReceipt, refreshTick }) {
  const webRef = useRef(null);
  const [loading, setLoading] = useState(false);

  // 🔸 ADDED: base for your eprint API
  const EPRINT_BASE = 'https://esmartpos.com/eprint/posprint.php/eprint?';

  // Make window.messageHandler available to the page before it loads
  const injectedJS = `
    (function () {
      if (!window.messageHandler) {
        window.messageHandler = {
          postMessage: function (msg) {
            try { window.ReactNativeWebView.postMessage(msg); } catch (e) {}
          }
        };
      }
      // 🔸 ADDED: optional callback the app can call to notify the page
      if (!window.onNative) {
        window.onNative = function (payload) {
          try { console.log('onNative:', payload); } catch (e) {}
        };
      }
    })();
    true;
  `;

  // 🔸 ADDED: helper to send a response back into the web page
  const sendBackToPage = (obj) => {
    if (!webRef.current) return;
    const js = `
      try {
        if (window.onNative) window.onNative(${JSON.stringify(obj)});
      } catch (e) {}
      true;
    `;
    webRef.current.injectJavaScript(js);
  };

  // Receive messages from the web page (e.nativeEvent.data)
  const onWebMessage = async (e) => {
    let raw = e?.nativeEvent?.data;
    if (!raw) return;

    // 🔸 ADDED: handle "esmartpos:..." command strings
    if (typeof raw === 'string' && raw.startsWith('esmartpos:')) {
      try {
        const queryString = raw.slice('esmartpos:'.length); // everything after "esmartpos:"
        const url = EPRINT_BASE + queryString;

        // Get receipt JSON from your API
        const res = await fetch(url, { method: 'GET' });
        const txt = await res.text();

        // Try to parse JSON (if API returns JSON)
        let payload = txt;
        try { payload = JSON.parse(txt); } catch {}

        // 1) Bubble up to App (which will EMIT to printer)
        onReceipt?.(payload);

        // 2) Tell the web page we’re done (optional UI feedback)
        sendBackToPage({ ok: true, url, printed: true });
      } catch (err) {
        sendBackToPage({ ok: false, error: String(err?.message || err) });
        Alert.alert('Print Error', String(err?.message || err));
      }
      return; // don't fall through
    }

    // Your existing flexible JSON pipeline
    let payload = raw;
    try { payload = JSON.parse(payload); } catch {}
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }

    globalThis.__LATEST_RECEIPT_JSON = payload; // optional global for your printer screen
    onReceipt?.(payload);                        // bubble up to App (this will EMIT to printer too)
  };

  // Listen for header refresh events and reload the WebView
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('HOME_REFRESH', () => {
      if (webRef.current) webRef.current.reload();
    });
    return () => sub?.remove?.();
  }, []);

  // Also refresh if refreshTick increases (forces reload even if page blocks it)
  useEffect(() => {
    if (webRef.current) webRef.current.reload();
  }, [refreshTick]);

  return (
    <View style={{ flex: 1 }}>
      {webUrl ? (
        <View style={{ flex: 1 }}>
          <WebView
            ref={webRef}
            source={{ uri: webUrl }}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            startInLoadingState
            javaScriptEnabled
            domStorageEnabled
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
            injectedJavaScriptBeforeContentLoaded={injectedJS}
            onMessage={onWebMessage}
          />
          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator />
            </View>
          )}
        </View>
      ) : (
        <View style={{ flex: 1, backgroundColor: '#fff' }} />
      )}
    </View>
  );
}

/** Drawer content: your printer controls */
function BluetoothDrawerContent(props) {
  return (
    <DrawerContentScrollView {...props} contentContainerStyle={styles.drawerContainer}>
      <BluetoothPrinterScreen />
    </DrawerContentScrollView>
  );
}

export default function App() {
  // URL modal state
  const [urlModalVisible, setUrlModalVisible] = useState(false);
  const [urlText, setUrlText] = useState('');

  // The URL shown inside the WebView on Home
  const [webUrl, setWebUrl] = useState('');

  // latest JSON received from the web page
  const [lastReceipt, setLastReceipt] = useState(null);

  // kept but not used UI
  const [jsonModalVisible, setJsonModalVisible] = useState(false);

  // tick to force a WebView reload from the header refresh button
  const [refreshTick, setRefreshTick] = useState(0);

  // ⬇️ Load saved URL on app start
  useEffect(() => {
    (async () => {
      const prefs = await readPrefs();
      if (prefs?.webUrl && typeof prefs.webUrl === 'string') {
        setWebUrl(prefs.webUrl);
        setUrlText(prefs.webUrl); // prefill modal text with saved URL
      }
    })();
  }, []);

  const openSearch = () => setUrlModalVisible(true);
  const onCancel = () => setUrlModalVisible(false);

  const onGo = () => {
    let u = (urlText || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`; // prepend scheme if missing
    setWebUrl(u);
    // ⬇️ Persist it for next app launch
    writePrefs({ webUrl: u });
    setUrlModalVisible(false);
  };

  // (kept; not used) prepared list
  const jsonLines = useMemo(() => {
    try {
      if (lastReceipt == null) return ['{}'];
      const text = typeof lastReceipt === 'string'
        ? lastReceipt
        : JSON.stringify(lastReceipt, null, 2);
      return String(text).split('\n');
    } catch {
      return [String(lastReceipt ?? '{}')];
    }
  }, [lastReceipt]);

  // Header actions
  const handleHeaderRefresh = () => {
    DeviceEventEmitter.emit('HOME_REFRESH');
    setRefreshTick((n) => n + 1);
  };

  const handleHeaderInfo = () => {
    Alert.alert('Techsapphire', `Version: ${APP_VERSION}`);
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationContainer>
        <Drawer.Navigator
          drawerContent={(p) => <BluetoothDrawerContent {...p} />}

          // 🔹 Header styled & icons like your screenshot
          screenOptions={({ navigation }) => ({
            headerTitle: 'Techsapphire',
            headerTitleAlign: 'left',
            headerTitleStyle: {
              fontSize: 22,
              fontWeight: Platform.select({ ios: '700', android: '700' }),
              color: '#252525',
            },
            headerStyle: {
              backgroundColor: '#FFF6FB', // soft pink header bg
              elevation: 0,
              shadowOpacity: 0,
              borderBottomWidth: 1,
              borderBottomColor: '#F0E3EE',
            },
            headerTintColor: '#252525',
            drawerType: 'front',
            swipeEnabled: true,

            // LEFT: Hamburger (opens drawer)
            headerLeft: () => (
              <TouchableOpacity
                onPress={() => navigation.toggleDrawer()}
                style={{ paddingHorizontal: 14, paddingVertical: 6 }}
                accessibilityLabel="Open menu"
              >
                <View style={styles.burgerLine} />
                <View style={[styles.burgerLine, { width: 18, marginTop: 3 }]} />
                <View style={[styles.burgerLine, { width: 22, marginTop: 3 }]} />
              </TouchableOpacity>
            ),

            // RIGHT: Search, Refresh, Info (spacing & sizes like screenshot)
            headerRight: () => (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {/* Search (magnifier) */}
                <TouchableOpacity onPress={openSearch} style={{ paddingHorizontal: 10 }}>
                  <Text style={styles.navIcon}>🔍</Text>
                </TouchableOpacity>

                {/* Refresh (clockwise arrow) */}
                <TouchableOpacity onPress={handleHeaderRefresh} style={{ paddingHorizontal: 10 }}>
                  <Text style={styles.navIcon}>↻</Text>
                </TouchableOpacity>

                {/* Info (circled i) */}
                <TouchableOpacity onPress={handleHeaderInfo} style={{ paddingLeft: 10, paddingRight: 14 }}>
                  <Text style={styles.navIcon}>ⓘ</Text>
                </TouchableOpacity>
              </View>
            ),
          })}
        >
          <Drawer.Screen name="Home">
            {() => (
              <HomeScreen
                webUrl={webUrl}
                setWebUrl={setWebUrl}
                latestReceipt={lastReceipt}
                refreshTick={refreshTick}
                onReceipt={(json) => {
                  setLastReceipt(json);
                  // Also push to printer as before
                  DeviceEventEmitter.emit('PRINT_JSON', json);
                }}
              />
            )}
          </Drawer.Screen>
        </Drawer.Navigator>
      </NavigationContainer>

      {/* URL Modal */}
      <Modal
        visible={urlModalVisible}
        animationType="fade"
        transparent
        onRequestClose={onCancel}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Enter URL</Text>
            <TextInput
              placeholder="https://example.com"
              value={urlText}
              onChangeText={setUrlText}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <View style={styles.row}>
              <Button title="Cancel" onPress={onCancel} />
              <View style={{ width: 12 }} />
              <Button title="Go" onPress={onGo} />
            </View>
          </View>
        </View>
      </Modal>

      {/* JSON viewer kept in code but not opened anymore */}
      <Modal
        visible={jsonModalVisible}
        animationType="slide"
        onRequestClose={() => setJsonModalVisible(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerTitle}>Received JSON</Text>
            <TouchableOpacity onPress={() => setJsonModalVisible(false)} style={styles.viewerCloseBtn}>
              <Text style={{ fontSize: 16 }}>Close</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            horizontal
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1 }}
            showsHorizontalScrollIndicator
            bounces={false}
            nestedScrollEnabled
          >
            <FlatList
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 12 }}
              data={jsonLines}
              keyExtractor={(_, i) => String(i)}
              renderItem={({ item }) => (
                <Text
                  selectable
                  allowFontScaling={false}
                  style={styles.jsonLine}
                >
                  {item.length ? item : ' '}
                </Text>
              )}
              initialNumToRender={200}
              maxToRenderPerBatch={200}
              windowSize={21}
              removeClippedSubviews={false}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              getItemLayout={(data, index) => ({
                length: 18,
                offset: 18 * index,
                index,
              })}
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // Drawer
  drawerContainer: { padding: 0 },

  // Simple hamburger bars
  burgerLine: {
    width: 24,
    height: 2.2,
    backgroundColor: '#252525',
    borderRadius: 2,
  },

  // Right-side icons size
  navIcon: { fontSize: 20, color: '#252525' },

  // Modal (URL)
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', justifyContent: 'flex-end' },

  // Loading overlay
  loadingOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },

  // JSON viewer header
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  viewerTitle: { fontSize: 16, fontWeight: '700' },
  viewerCloseBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
  },

  // Each JSON line
  jsonLine: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    color: '#111',
    includeFontPadding: false,
  },
});
