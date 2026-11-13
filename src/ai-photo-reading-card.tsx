import React from 'react';
import { Switch, Text, View } from 'react-native';
import { C, Card, s } from './ui';
import { saveAiPhotoReading, useAiPhotoReading } from './ai-photo-consent';

/** The patient's standing choice for the AI pouch reading offered in the camera. */
export function AiPhotoReadingCard() {
  const choice = useAiPhotoReading();
  return <Card>
    <View style={[s.row, { gap: 12 }]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={s.section}>AI 약봉투 읽기</Text>
        <Text style={s.muted}>촬영한 약봉투에 적힌 복용 시간을 AI가 읽어 이번 회차와 맞는지 알려 줘요. 사진(봉투에 인쇄된 이름 등 포함)은 미국 기업 Anthropic의 AI로 보내지고, 메타케어 서버는 저장하지 않지만 Anthropic은 자체 정책에 따라 일정 기간 보관할 수 있어요. 약을 먹었는지 확인하는 기능은 아니에요.</Text>
      </View>
      <Switch
        accessibilityLabel="AI 약봉투 읽기"
        disabled={choice === undefined}
        value={choice === 'on'}
        onValueChange={value => { void saveAiPhotoReading(value ? 'on' : 'off').catch(() => undefined); }}
        trackColor={{ false: '#dfe5ee', true: C.blue }}
        thumbColor="white"
      />
    </View>
  </Card>;
}
