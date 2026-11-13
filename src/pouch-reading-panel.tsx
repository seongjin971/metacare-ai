import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, C, Icon, s, type IconName } from './ui';
import type { PhotoReading } from './dose-photo';
import { photoReadingMessage } from './pouch-reading-outcome';

export type AiReadingState =
  | { status: 'off' }
  | { status: 'ask' }
  | { status: 'reading' }
  | { status: 'done'; reading: PhotoReading }
  | { status: 'failed' };

const AMBER = '#a66b1d';

/** Shown under the photo preview. It informs; the record button never waits for it. */
export function PouchReadingPanel({ state, label, onAllow, onDecline }: {
  state: AiReadingState; label: string; onAllow: () => void; onDecline: () => void;
}) {
  if (state.status === 'off') return null;
  if (state.status === 'ask') {
    return <View style={styles.ask}>
      <Text style={styles.askTitle}>AI로 약봉투 글씨를 읽어 볼까요?</Text>
      <Text style={styles.askBody}>봉투에 적힌 복용 시간이 이번 회차와 맞는지 알려 드려요. 사진(봉투에 인쇄된 이름 등 포함)은 미국 기업 Anthropic의 AI로 보내져요. 메타케어 서버는 저장하지 않지만, Anthropic은 자체 정책에 따라 일정 기간 보관할 수 있어요. 동의하면 앞으로 찍는 사진마다 읽어요. 내 관리에서 언제든 끌 수 있어요.</Text>
      <View style={styles.actions}>
        <View style={{ flex: 1 }}><Button title="괜찮아요" secondary small onPress={onDecline} /></View>
        <View style={{ flex: 1 }}><Button title="AI로 읽기" small icon="sparkles-outline" onPress={onAllow} /></View>
      </View>
    </View>;
  }
  if (state.status === 'reading') {
    return <View accessibilityLiveRegion="polite" style={styles.row}>
      <ActivityIndicator color={C.blue} />
      <Text style={s.muted}>AI가 약봉투 글씨를 읽고 있어요…</Text>
    </View>;
  }
  if (state.status === 'failed') {
    return <Text accessibilityLiveRegion="polite" style={s.muted}>지금은 AI로 읽을 수 없어요. 그대로 기록해도 돼요.</Text>;
  }
  const { outcome } = state.reading;
  const [icon, color]: [IconName, string] = outcome === 'match' ? ['checkmark-circle', C.green]
    : outcome === 'mismatch' ? ['alert-circle', AMBER] : outcome === 'read' ? ['information-circle', C.blue] : ['help-circle', C.muted];
  return <View accessibilityLiveRegion="polite" style={[styles.row, styles.result, outcome === 'mismatch' && styles.warning]}>
    <Icon name={icon} size={20} color={color} />
    <Text style={[styles.resultText, { color: outcome === 'mismatch' ? AMBER : C.navy }]}>{photoReadingMessage(state.reading, label)}</Text>
  </View>;
}

const styles = StyleSheet.create({
  ask: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.pale },
  askTitle: { color: C.navy, fontSize: 15, fontWeight: '700' },
  askBody: { color: C.navy, fontSize: 13, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  result: { padding: 10, borderRadius: 10, backgroundColor: C.bg },
  warning: { backgroundColor: '#fff8ec' },
  resultText: { flex: 1, fontSize: 14, lineHeight: 21 },
});
