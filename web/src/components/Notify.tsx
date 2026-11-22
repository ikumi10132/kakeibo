import { useEffect, useState } from 'react';
import { api, type NotifySettings, type PushInfo } from '../api';
import type { Shared } from '../App';

/** iPhone などへの通知 (Web プッシュ) の設定。通知は端末ごとに許可する */

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'PC';
}

/** VAPID の公開鍵 (base64url) をブラウザが受け取れる形にする */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function Notify({ toast, handleError }: Shared) {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = supported();

  const load = async () => {
    try {
      const [i, sub] = await Promise.all([api.push(), ok ? currentSubscription() : Promise.resolve(null)]);
      setInfo(i);
      setSubscribed(!!sub);
    } catch (e) {
      handleError(e);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  /** この端末で通知を受け取る (iPhone の許可画面が出る) */
  const enable = () =>
    run(async () => {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('通知が許可されませんでした。iPhone の「設定 → 通知 → 家計簿」からオンにできます', true);
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info!.publicKey) }));
      await api.subscribePush(sub.toJSON(), deviceName());
      toast('この端末で通知を受け取ります');
      await load();
    });

  const disable = () =>
    run(async () => {
      const sub = await currentSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      toast('この端末の通知をオフにしました');
      await load();
    });

  const test = () =>
    run(async () => {
      const r = await api.testPush();
      toast(r.sent ? `テスト通知を送りました (${r.sent} 台)` : '通知を受け取る端末がありません', !r.sent);
    });

  const change = (k: keyof NotifySettings, v: boolean) =>
    run(async () => {
      const next = await api.savePushSettings({ ...info!.settings, [k]: v });
      setInfo({ ...info!, settings: next });
    });

  return (
    <>
      <section className="card">
        <h2 className="card-title">この端末の通知</h2>
        {!ok && isIos() && !isStandalone() && (
          <div className="info-box small">
            <strong>ホーム画面に追加した家計簿から開いてください</strong>
            <span>iPhone では、Safari の共有メニュー →「ホーム画面に追加」で追加した家計簿でだけ通知を受け取れます (iOS 16.4 以降)。</span>
          </div>
        )}
        {!ok && !(isIos() && !isStandalone()) && <p className="muted small">このブラウザは通知に対応していません。</p>}
        {ok && subscribed === null && <p className="muted small">確認中…</p>}
        {ok && subscribed === false && (
          <>
            <p className="small">
              カードの利用通知メールから記録したときや、相手が waripo で割り勘にしたときに、この端末に通知します。
            </p>
            {typeof Notification !== 'undefined' && Notification.permission === 'denied' ? (
              <p className="small error-text">
                通知がブロックされています。iPhone の「設定 → 通知 → 家計簿」で「通知を許可」をオンにしてから、もう一度お試しください。
              </p>
            ) : (
              <button className="btn btn-primary" disabled={busy || !info} onClick={() => void enable()}>この端末で通知を受け取る</button>
            )}
          </>
        )}
        {ok && subscribed && (
          <>
            <p className="small">この端末で通知を受け取っています。</p>
            <div className="btn-row">
              <button className="btn btn-outline" disabled={busy} onClick={() => void test()}>テスト通知を送る</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void disable()}>この端末の通知をオフ</button>
            </div>
          </>
        )}
        {info && <p className="muted small">通知を受け取る端末: {info.devices} 台</p>}
      </section>

      {info && (
        <section className="card">
          <h2 className="card-title">通知する内容</h2>
          <p className="muted small">あなたが登録したすべての端末に共通の設定です。</p>
          <label className="switch-row">
            <span>
              <strong>メールから自動で記録したとき</strong>
              <span className="muted small"> カードの利用通知メール (Gmail・iPhone のメール) から記録したとき</span>
            </span>
            <input type="checkbox" role="switch" checked={info.settings.mail} disabled={busy} onChange={(e) => void change('mail', e.target.checked)} />
          </label>
          <label className="switch-row">
            <span>
              <strong>waripo で割り勘にされたとき</strong>
              <span className="muted small"> 相手が割り勘にして、あなたの家計簿に負担分が入ったとき</span>
            </span>
            <input type="checkbox" role="switch" checked={info.settings.waripo} disabled={busy} onChange={(e) => void change('waripo', e.target.checked)} />
          </label>
          <p className="muted small">Apple Pay のショートカットで記録したときは、ショートカットが通知を出すので、ここからは送りません。</p>
        </section>
      )}
    </>
  );
}
