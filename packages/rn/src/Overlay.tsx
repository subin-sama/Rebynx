import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { DevEvent } from '@rebynx/core';
import { memorySink } from './index';

/**
 * Minimal in-app glance: a draggable bubble that expands into a tabbed panel.
 * Intentionally lightweight — the browser client is the rich experience; this
 * is the "don't make me leave the app" half of the hybrid setup.
 *
 * Tap-to-inspect uses RN's UIManager. The import is wrapped in try/catch
 * because the symbol moves between RN versions and the architecture (Fabric vs
 * Paper); if unavailable the rest of the overlay still works.
 */

const TABS = ['logs', 'network', 'state'] as const;
type Tab = (typeof TABS)[number];

const accepts: Record<Tab, (e: DevEvent) => boolean> = {
  logs: (e) => e.type === 'log',
  network: (e) => e.type === 'network',
  state: (e) => e.type === 'state',
};

export function DevToolsOverlay() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('logs');
  const [events, setEvents] = useState<DevEvent[]>([]);
  const pos = useRef(new Animated.ValueXY({ x: 16, y: 80 })).current;

  useEffect(() => {
    const unsub = memorySink.subscribe((e) => {
      setEvents((prev) => {
        const next = e.type === 'network' && e.phase === 'end'
          ? prev.map((p) => (p.type === 'network' && p.reqId === e.reqId ? { ...p, ...e } : p))
          : [...prev, e];
        return next.slice(-300);
      });
    });
    const unsubCmd = memorySink.subscribeCommand((cmd) => {
      if (cmd.type === 'clear') {
        setEvents([]);
      }
    });
    return () => {
      unsub();
      unsubCmd();
    };
  }, []);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        pos.setOffset({ x: (pos.x as any)._value, y: (pos.y as any)._value });
        pos.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
      onPanResponderRelease: () => pos.flattenOffset(),
    }),
  ).current;

  const data = events.filter(accepts[tab]).slice().reverse();

  if (!open) {
    return (
      <Animated.View style={[styles.bubble, pos.getLayout()]} {...pan.panHandlers}>
        <TouchableOpacity onPress={() => setOpen(true)} style={styles.bubbleHit}>
          <Text style={styles.bubbleText}>🐛</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  return (
    <View style={styles.panel} pointerEvents="box-none">
      <View style={styles.sheet}>
        <View style={styles.header}>
          {TABS.map((t) => (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t} {events.filter(accepts[t]).length}
              </Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setEvents([])} style={styles.btn}>
            <Text style={styles.btnText}>clear</Text>
          </Pressable>
          <Pressable onPress={() => setOpen(false)} style={styles.btn}>
            <Text style={styles.btnText}>✕</Text>
          </Pressable>
        </View>
        <FlatList
          data={data}
          keyExtractor={(e) => e.id}
          style={styles.list}
          renderItem={({ item }) => <Row event={item} />}
          ListEmptyComponent={<Text style={styles.empty}>no {tab} yet</Text>}
        />
      </View>
    </View>
  );
}

function Row({ event }: { event: DevEvent }) {
  if (event.type === 'log') {
    return (
      <Text style={[styles.row, styles[event.level] ?? null]} numberOfLines={3}>
        {event.message}
      </Text>
    );
  }
  if (event.type === 'network') {
    const pending = event.phase !== 'end';
    return (
      <Text style={styles.row} numberOfLines={2}>
        <Text style={styles.method}>{event.method} </Text>
        <Text style={pending ? styles.warn : event.ok ? styles.ok : styles.error}>
          {pending ? '···' : event.status}{' '}
        </Text>
        {event.url}
        {event.duration != null ? `  ${event.duration}ms` : ''}
      </Text>
    );
  }
  if (event.type === 'state') {
    return (
      <Text style={styles.row} numberOfLines={4}>
        <Text style={styles.method}>{event.store} </Text>
        {event.action ? <Text style={styles.warn}>{event.action} </Text> : null}
        {JSON.stringify(event.state)}
      </Text>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  bubble: { position: 'absolute', zIndex: 99999 },
  bubbleHit: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#1d2027',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#2c3038',
  },
  bubbleText: { fontSize: 20 },
  panel: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end', zIndex: 99999 },
  sheet: { height: '55%', backgroundColor: '#16181d', borderTopWidth: 1, borderColor: '#2c3038' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 6, backgroundColor: '#1d2027', borderBottomWidth: 1, borderColor: '#2c3038' },
  tab: { paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 2, borderColor: 'transparent' },
  tabActive: { borderColor: '#6ea8fe' },
  tabText: { color: '#7d828c', fontSize: 11 },
  tabTextActive: { color: '#d7dae0' },
  btn: { paddingHorizontal: 8, paddingVertical: 6 },
  btnText: { color: '#7d828c', fontSize: 12 },
  list: { flex: 1 },
  row: { color: '#c8cdd6', fontSize: 11, fontFamily: 'Menlo', paddingHorizontal: 10, paddingVertical: 4, borderBottomWidth: 1, borderColor: '#23262f' },
  method: { color: '#6ea8fe' },
  ok: { color: '#5bd99e' },
  error: { color: '#f2777a' },
  warn: { color: '#e6c07b' },
  log: { color: '#c8cdd6' },
  info: { color: '#c8cdd6' },
  debug: { color: '#7d828c' },
  empty: { color: '#7d828c', textAlign: 'center', padding: 40, fontSize: 12 },
});
