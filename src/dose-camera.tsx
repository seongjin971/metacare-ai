import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Image, Linking, Modal, Platform, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, C, Icon, s } from './ui';
import { stampDosePhoto, type DoseCapture } from './stamp-dose-photo';
import { choosePictureSize } from './picture-size';
import { sharpenWebCamera } from './web-camera-resolution';
import { FadeIn, MotionPressable as Pressable, useReducedMotion } from './motion';
import { loadAiPhotoReading, saveAiPhotoReading } from './ai-photo-consent';
import { requestPouchReading } from './ai-pouch-read';
import { photoReadingFor } from './pouch-reading-outcome';
import { PouchReadingPanel, type AiReadingState } from './pouch-reading-panel';

/** The AI reading needs the photo as a data URL, which only the web camera produces for now. */
const AI_READING = Platform.OS === 'web';

type Props = {
  label: string;
  onClose: () => void;
  onSave: (capture: DoseCapture, canCommit: () => boolean) => Promise<boolean>;
};

/** A new live-camera capture, stamped with its time and confirmed by the patient, is the only route to the save callback. */
export function DoseCamera({ label, onClose, onSave }: Props) {
  const reducedMotion = useReducedMotion();
  const inset = useSafeAreaInsets();
  const camera = useRef<CameraView | null>(null);
  const stage = useRef<React.ComponentRef<typeof View>>(null);
  const alive = useRef(true);
  const active = useRef(AppState.currentState === 'active');
  const captureSession = useRef(0);
  // Bumped whenever the live camera may change, so a slow onCameraReady for an older camera cannot enable capture.
  const cameraGeneration = useRef(0);
  const busyRef = useRef<'permission' | 'capture' | 'stamp' | 'save' | null>(null);
  const [busy, setBusy] = useState<typeof busyRef.current>(null);
  const [permission, requestPermission, getPermission] = useCameraPermissions({ get: false });
  const [checkingPermission, setCheckingPermission] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [cameraKey, setCameraKey] = useState(0);
  const [mountFailed, setMountFailed] = useState(false);
  const [error, setError] = useState('');
  const [capture, setCapture] = useState<DoseCapture | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const sizeChecked = useRef(false);
  const [aiReading, setAiReading] = useState<AiReadingState>({ status: 'off' });
  // The unstamped frame: the time label must not cover any of the pouch's print.
  const aiSource = useRef<string | null>(null);

  const resetCamera = () => {
    cameraGeneration.current += 1;
    setReady(false);
  };

  const onCameraReady = async () => {
    if (!alive.current || !active.current) return;
    const generation = cameraGeneration.current;
    if (Platform.OS !== 'web' && !sizeChecked.current && camera.current) {
      sizeChecked.current = true;
      try {
        const size = choosePictureSize(await camera.current.getAvailablePictureSizesAsync());
        if (size && alive.current) setPictureSize(size);
      } catch { /* Keep the default size; saving still rejects photos above the sharing limit. */ }
    }
    // On the web the stage is a DOM element that contains the camera's <video>.
    if (Platform.OS === 'web') await sharpenWebCamera(stage.current);
    if (alive.current && active.current && generation === cameraGeneration.current) setReady(true);
  };

  const checkPermission = useCallback(async () => {
    try { await getPermission(); }
    catch {
      // Some browsers cannot query camera permission. The explicit request still works.
    } finally { if (alive.current) setCheckingPermission(false); }
  }, [getPermission]);

  useEffect(() => {
    alive.current = true;
    void checkPermission();
    const subscription = AppState.addEventListener('change', state => {
      const isActive = state === 'active';
      active.current = isActive;
      setForeground(isActive);
      cameraGeneration.current += 1;
      setReady(false);
      if (!isActive) {
        captureSession.current += 1;
        if (busyRef.current === 'stamp' || busyRef.current === 'capture') setError('촬영이 중단됐어요. 다시 촬영해 주세요.');
      }
      else void checkPermission();
    });
    return () => {
      alive.current = false;
      captureSession.current += 1;
      subscription.remove();
    };
  }, [checkPermission]);

  const close = () => {
    if (busyRef.current === 'save') return;
    alive.current = false;
    captureSession.current += 1;
    onClose();
  };

  const requestCamera = async () => {
    if (busyRef.current) return;
    busyRef.current = 'permission';
    setBusy('permission');
    setError('');
    try {
      const result = await requestPermission();
      if (!alive.current) return;
      if (!result.granted) {
        setError(Platform.OS === 'web'
          ? '카메라를 사용할 수 없어요. 기기 연결과 브라우저의 카메라 권한을 확인해 주세요.'
          : '카메라 권한을 허용해야 사진으로 기록할 수 있어요.');
      }
      setMountFailed(false);
      resetCamera();
      setCameraKey(value => value + 1);
    } catch {
      if (alive.current) setError('카메라를 사용할 수 없어요. 기기 연결과 카메라 권한을 확인해 주세요.');
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
    }
  };

  /**
   * Reads the photo on screen with the AI. The result belongs to that photo: it is dropped only after
   * a retake or close, not when the app briefly goes to the background while the photo stays.
   */
  const readPouch = async () => {
    const source = aiSource.current;
    if (!source) return;
    setAiReading({ status: 'reading' });
    try {
      const reading = await requestPouchReading(source);
      if (alive.current && aiSource.current === source) setAiReading({ status: 'done', reading: photoReadingFor(reading, label) });
    } catch {
      if (alive.current && aiSource.current === source) setAiReading({ status: 'failed' });
    }
  };

  const allowAiReading = () => {
    void saveAiPhotoReading('on').catch(() => undefined);
    void readPouch();
  };

  const declineAiReading = () => {
    void saveAiPhotoReading('off').catch(() => undefined);
    setAiReading({ status: 'off' });
  };

  const saveCapture = async (captured: DoseCapture) => {
    const session = captureSession.current;
    const canCommit = () => alive.current && active.current && session === captureSession.current;
    if (!canCommit() || busyRef.current === 'save') return;
    busyRef.current = 'save';
    setBusy('save');
    setError('');
    setSaveFailed(false);
    // A reading still in progress is left out rather than holding up the record.
    const photo = aiReading.status === 'done' ? { ...captured, reading: aiReading.reading } : captured;
    const saved = await onSave(photo, canCommit).catch(() => false);
    busyRef.current = null;
    if (!alive.current) return;
    setBusy(null);
    // A successful durable write still counts if the app went into the background during the write.
    if (saved) onClose();
    else { setSaveFailed(true); setError('기록을 저장하지 못했어요. 다시 저장하거나 다시 촬영해 주세요.'); }
  };

  const takePhoto = async () => {
    if (busyRef.current || !ready || !camera.current || !active.current || capture) return;
    busyRef.current = 'capture';
    setBusy('capture');
    setError('');
    const session = captureSession.current;
    const isCurrent = () => alive.current && active.current && session === captureSession.current;
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.85, exif: false, imageType: 'jpg' });
      if (!isCurrent()) return;
      if (!photo?.uri || !Number.isFinite(photo.width) || !Number.isFinite(photo.height) || photo.width <= 0 || photo.height <= 0) {
        throw new Error('empty capture');
      }
      const captured = { uri: photo.uri, width: photo.width, height: photo.height, capturedAt: new Date().toISOString() };
      setReady(false);
      busyRef.current = 'stamp';
      setBusy('stamp');
      // The preview shows the stamped photo exactly as the caregiver will see it.
      const stamped = await stampDosePhoto(captured);
      if (!isCurrent()) return;
      setCapture(stamped);
      if (AI_READING) {
        aiSource.current = captured.uri;
        // Reread for each photo so turning it off in another tab or in settings takes effect.
        const choice = await loadAiPhotoReading({ fresh: true });
        if (!isCurrent()) return;
        if (choice === 'on') void readPouch();
        else if (choice === null) setAiReading({ status: 'ask' });
      }
    } catch {
      if (isCurrent()) setError('사진을 처리하지 못했어요. 다시 촬영해 주세요.');
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
    }
  };

  const retake = () => {
    if (busyRef.current) return;
    captureSession.current += 1;
    setCapture(null);
    setAiReading({ status: 'off' });
    aiSource.current = null;
    setSaveFailed(false);
    resetCamera();
    setMountFailed(false);
    setError('');
    setCameraKey(value => value + 1);
  };

  const cameraVisible = permission?.granted && !capture && foreground && !mountFailed && busy !== 'permission';
  const permissionBlocked = permission?.canAskAgain === false && !permission.granted;

  return (
    <Modal visible transparent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={close}>
      <View style={[styles.backdrop, { paddingTop: Math.max(16, inset.top), paddingBottom: Math.max(16, inset.bottom) }]}>
        <View accessibilityViewIsModal accessibilityLabel="복약 사진 촬영" style={styles.panel}>
          <View style={styles.header}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text accessibilityRole="header" style={styles.title}>약봉투 촬영</Text>
              <Text style={s.muted}>{label}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="촬영 취소" disabled={busy === 'save'} accessibilityState={{ disabled: busy === 'save' }} onPress={close} style={styles.close}>
              <Icon name="close" color={busy === 'save' ? C.muted : C.navy} />
            </Pressable>
          </View>
          <View ref={stage} style={[styles.stage, (cameraVisible || !!capture) && styles.darkStage]}>
            {busy === 'stamp' ? (
              <View style={styles.center}><ActivityIndicator color="white" /><Text style={styles.loading}>사진 준비 중…</Text></View>
            ) : capture ? (
              <Image source={{ uri: capture.uri }} accessibilityLabel="촬영한 복약 사진" style={styles.preview} resizeMode="contain" />
            ) : cameraVisible ? (
              <>
                <CameraView
                  key={cameraKey}
                  ref={camera}
                  style={StyleSheet.absoluteFill}
                  facing={facing}
                  mode="picture"
                  flash="off"
                  mute
                  autofocus="on"
                  pictureSize={pictureSize}
                  onCameraReady={() => { void onCameraReady(); }}
                  onMountError={() => {
                    if (!alive.current) return;
                    resetCamera();
                    setMountFailed(true);
                    setError('카메라를 사용할 수 없어요. 다른 앱에서 사용 중인지와 카메라 권한을 확인해 주세요.');
                  }}
                />
                {!ready && <View style={styles.center}><ActivityIndicator color="white" /><Text style={styles.loading}>카메라 준비 중…</Text></View>}
              </>
            ) : (
              <View style={styles.center}>
                {checkingPermission || busy === 'permission' ? <ActivityIndicator color={C.blue} /> : <Icon name="camera-outline" size={42} color={C.muted} />}
                <Text style={styles.message}>
                  {checkingPermission ? '카메라를 확인하고 있어요.'
                    : !foreground ? '앱으로 돌아오면 촬영을 이어갈 수 있어요.'
                      : mountFailed ? '카메라를 사용할 수 없어요.'
                        : permissionBlocked ? '휴대폰 설정에서 카메라 권한을 허용해 주세요.'
                          : '먹을 약봉투가 잘 보이게 촬영해 주세요.'}
                </Text>
                {!checkingPermission && foreground && !permission?.granted && (
                  <Button
                    title={busy === 'permission' ? '권한 확인 중…' : permissionBlocked && Platform.OS !== 'web' ? '휴대폰 설정 열기' : '카메라 허용'}
                    disabled={!!busy}
                    onPress={() => {
                      if (permissionBlocked && Platform.OS !== 'web') {
                        void Linking.openSettings().catch(() => { if (alive.current) setError('휴대폰 설정에서 메타케어의 카메라 권한을 켜 주세요.'); });
                      } else void requestCamera();
                    }}
                  />
                )}
                {mountFailed && permission?.granted && foreground && <Button title="다시 시도" secondary onPress={retake} />}
              </View>
            )}
          </View>
          {(!!error || !!capture || cameraVisible) && <View style={styles.footer}>
            {/* Notes scroll on a short screen so the buttons below always stay in view. */}
            <ScrollView style={styles.notes} contentContainerStyle={styles.notesContent}>
              {cameraVisible && !error && <Text style={s.muted}>찍은 날짜와 시간이 사진에 함께 남아요.</Text>}
              {capture && !busy && !error && <Text style={s.muted}>이 사진이 보호자에게 전달돼요.</Text>}
              {capture && busy !== 'stamp' && <PouchReadingPanel state={aiReading} label={label} onAllow={allowAiReading} onDecline={declineAiReading} />}
              {!!error && <FadeIn motionKey={error} style={{ gap: 4 }}>
                {saveFailed && <Text style={styles.failureTitle}>기록 저장 실패</Text>}
                <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
              </FadeIn>}
            </ScrollView>
            {capture ? (
              busy ? <View accessibilityLiveRegion="polite" style={styles.processing}>
                <ActivityIndicator color={C.blue} />
                <Text style={styles.processingText}>{busy === 'save' ? '기록 저장 중…' : '사진 준비 중…'}</Text>
              </View> : <View style={styles.actions}>
                <View style={{ flex: 1 }}><Button title="다시 촬영" secondary onPress={retake} /></View>
                <View style={{ flex: 1 }}><Button title={saveFailed ? '다시 저장' : '이 사진으로 기록'} disabled={!foreground} onPress={() => void saveCapture(capture)} /></View>
              </View>
            ) : cameraVisible ? (
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button" accessibilityLabel="카메라 전환"
                  accessibilityState={{ disabled: !cameraVisible || !!busy }} disabled={!cameraVisible || !!busy}
                  onPress={() => {
                    resetCamera();
                    setFacing(value => value === 'back' ? 'front' : 'back');
                    // expo-camera on the web keeps a same-device stream without firing onCameraReady again
                    // (a laptop's single webcam), so remount to get a fresh stream and a ready signal.
                    if (Platform.OS === 'web') setCameraKey(value => value + 1);
                  }}
                  style={styles.flip}
                ><Icon name="camera-reverse-outline" color={cameraVisible && !busy ? C.blue : C.muted} /></Pressable>
                <View style={{ flex: 1 }}><Button title={busy === 'capture' ? '촬영 중…' : '사진 촬영'} icon="camera-outline" disabled={!cameraVisible || !ready || !!busy} onPress={() => void takePhoto()} /></View>
              </View>
            ) : null}
          </View>}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#14213b66', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  panel: { width: '100%', maxWidth: 480, height: '90%', maxHeight: 760, backgroundColor: C.white, borderRadius: 16, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  title: { color: C.navy, fontSize: 20, fontWeight: '700' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1, minHeight: 160, backgroundColor: C.bg, overflow: 'hidden' },
  darkStage: { backgroundColor: '#132036' },
  preview: { width: '100%', height: '100%' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24 },
  message: { fontSize: 15, lineHeight: 24, color: C.navy, textAlign: 'center' },
  loading: { color: C.white, fontSize: 14 },
  footer: { padding: 16, gap: 12, flexShrink: 1 },
  notes: { flexGrow: 0, flexShrink: 1 },
  notesContent: { gap: 12 },
  processing: { minHeight: 48, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  processingText: { color: C.navy, fontSize: 15, fontWeight: '600' },
  failureTitle: { color: C.navy, fontSize: 16, fontWeight: '700' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flip: { width: 48, height: 48, borderRadius: 9, backgroundColor: C.pale, justifyContent: 'center', alignItems: 'center' },
  error: { color: '#b04444', fontSize: 13, lineHeight: 20 },
});
