import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Category, InstallmentsResponse, Transaction } from '../../api/src/types';
import { api, AuthError } from './api';
import { handleRedirect, isLoggedIn, login, logout } from './auth';
import { AdvancesPage } from './components/Advances';
import { Home } from './components/Home';
import { IconGear, IconHome, IconInbox, IconInstallment, IconList, IconLogout, IconPlus, IconSwap } from './components/Icons';
import { InstallmentsPage } from './components/Installments';
import { Inbox } from './components/Inbox';
import { Settings } from './components/Settings';
import { TxForm } from './components/TxForm';
import { TxList } from './components/TxList';
import { loadConfig } from './config';
import { thisMonth } from './util';

type Phase = { name: 'loading' } | { name: 'login' } | { name: 'ready' } | { name: 'error'; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    (async () => {
      try {
        await loadConfig();
        await handleRedirect();
        setPhase(isLoggedIn() ? { name: 'ready' } : { name: 'login' });
      } catch (e) {
        setPhase({ name: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  if (phase.name === 'loading') return <div className="center muted">読み込み中…</div>;
  if (phase.name === 'error') {
    return (
      <div className="center">
        <p className="error-text">{phase.message}</p>
        <button className="btn" onClick={() => location.reload()}>再読み込み</button>
      </div>
    );
  }
  if (phase.name === 'login') {
    return (
      <div className="center login">
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>MyKakeibo!</h1>
        <button className="btn btn-primary btn-wide" onClick={() => login()}>W-SSO でログイン</button>
      </div>
    );
  }
  return <Main onAuthError={() => setPhase({ name: 'login' })} />;
}

export type Tab = 'home' | 'list' | 'inbox' | 'advances' | 'installments' | 'settings';

interface NavItem {
  id: Tab;
  label: string;
  icon: ReactNode;
}

/** PC の左メニュー */
const SIDE_NAV: NavItem[] = [
  { id: 'home', label: 'ホーム', icon: <IconHome /> },
  { id: 'list', label: '明細・カレンダー', icon: <IconList /> },
  { id: 'inbox', label: '未確認', icon: <IconInbox /> },
  { id: 'advances', label: '立て替え', icon: <IconSwap /> },
  { id: 'installments', label: '分割払い', icon: <IconInstallment /> },
];

export type Editing = { tx?: Transaction } | null;

export interface Shared {
  categories: Category[];
  reloadCategories: () => Promise<void>;
  /** 明細を変更したあとに呼ぶ */
  changed: () => void;
  edit: (tx?: Transaction) => void;
  toast: (text: string, error?: boolean) => void;
  handleError: (e: unknown) => void;
  /** 画面を切り替える */
  go: (tab: Tab) => void;
}

function Main({ onAuthError }: { onAuthError: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  const [month, setMonth] = useState(thisMonth);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<Transaction[] | null>(null);
  const [advances, setAdvances] = useState<Transaction[]>([]);
  const [installments, setInstallments] = useState<InstallmentsResponse | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const toast = useCallback((text: string, error = false) => {
    setToastMsg({ text, error });
    window.setTimeout(() => setToastMsg((t) => (t?.text === text ? null : t)), 3500);
  }, []);

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onAuthError();
      toast(e instanceof Error ? e.message : String(e), true);
    },
    [onAuthError, toast],
  );

  const reloadCategories = useCallback(async () => {
    try {
      setCategories(await api.categories());
    } catch (e) {
      handleError(e);
    }
  }, [handleError]);

  useEffect(() => {
    void reloadCategories();
  }, [reloadCategories]);

  useEffect(() => {
    let alive = true;
    setTxs(null);
    api.transactions(month).then((r) => alive && setTxs(r), handleError);
    return () => {
      alive = false;
    };
  }, [month, version, handleError]);

  useEffect(() => {
    api.unconfirmed().then(setUnconfirmed, handleError);
    api.openAdvances().then(setAdvances, handleError);
    api.installments().then(setInstallments, handleError);
  }, [version, handleError]);

  // アプリに戻ってきたとき (ショートカットで記録したあとなど) に最新にする
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && setVersion((v) => v + 1);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const go = useCallback((t: Tab) => {
    setTab(t);
    window.scrollTo({ top: 0 });
  }, []);

  // 通知から開いたとき (?tab=inbox など) は、その画面を表示する
  useEffect(() => {
    const open = (url: string) => {
      const t = new URL(url, location.origin).searchParams.get('tab');
      if (t && (['home', 'list', 'inbox', 'advances', 'installments', 'settings'] as string[]).includes(t)) go(t as Tab);
      setVersion((v) => v + 1);
    };
    if (new URLSearchParams(location.search).has('tab')) {
      open(location.href);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    // アプリを開いたまま通知を押したとき (サービスワーカーから届く)
    const onMessage = (e: MessageEvent<{ type?: string; url?: string }>) => {
      if (e.data?.type === 'open' && e.data.url) open(e.data.url);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [go]);

  // 「記録する」: ホームでは画面内のフォームへ移動、ほかの画面では下から出るシートを開く
  const add = () => {
    const form = tab === 'home' ? document.getElementById('quick-form') : null;
    if (!form) return setEditing({});
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => form.querySelector<HTMLInputElement>('.amount-input input')?.focus({ preventScroll: true }), 350);
  };

  if (!categories) return <div className="center muted">読み込み中…</div>;

  const shared: Shared = {
    categories,
    reloadCategories,
    changed: () => setVersion((v) => v + 1),
    edit: (tx) => setEditing({ tx }),
    toast,
    handleError,
    go,
  };
  const inboxCount = unconfirmed?.length ?? 0;
  const badge = (id: Tab) =>
    id === 'inbox' && inboxCount > 0 ? <span className="badge" aria-label={`${inboxCount} 件`}>{inboxCount}</span> : null;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="メインメニュー">
        <div className="brand">
          <img src="/icon.svg" alt="" width={36} height={36} />
          <span className="brand-text">
            <strong>MyKakeibo!</strong>
            <span className="muted small">{location.host}</span>
          </span>
        </div>
        <button className="btn btn-primary btn-block" onClick={add}>
          <IconPlus /> 記録する
        </button>
        <nav>
          <ul className="side-nav">
            {SIDE_NAV.map((n) => (
              <li key={n.id}>
                <button className={tab === n.id ? 'active' : ''} aria-current={tab === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
                  {n.icon}
                  <span className="grow">{n.label}</span>
                  {badge(n.id)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <ul className="side-nav side-foot">
          <li>
            <button className={tab === 'settings' ? 'active' : ''} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => go('settings')}>
              <IconGear />
              <span className="grow">設定</span>
            </button>
          </li>
          <li>
            <button onClick={logout}>
              <IconLogout />
              <span className="grow">ログアウト</span>
            </button>
          </li>
        </ul>
      </aside>

      <main className="main">
        {tab === 'home' && (
          <Home {...shared} month={month} setMonth={setMonth} txs={txs} advances={advances} unconfirmed={unconfirmed ?? []} installments={installments} />
        )}
        {tab === 'list' && <TxList {...shared} month={month} setMonth={setMonth} txs={txs} />}
        {tab === 'inbox' && <Inbox {...shared} txs={unconfirmed} />}
        {tab === 'advances' && <AdvancesPage {...shared} txs={advances} />}
        {tab === 'installments' && <InstallmentsPage {...shared} month={month} data={installments} />}
        {tab === 'settings' && <Settings {...shared} month={month} />}
      </main>

      {/* スマホの下のタブ (真ん中が「記録する」) */}
      <nav className="tabbar" aria-label="画面の切り替え">
        {([
          { id: 'home', label: 'ホーム', icon: <IconHome size={24} /> },
          { id: 'list', label: '明細', icon: <IconList size={24} /> },
        ] as NavItem[]).map((n) => (
          <button key={n.id} className={tab === n.id ? 'active' : ''} aria-current={tab === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
            {n.icon}
            <span>{n.label}</span>
          </button>
        ))}
        <button className="tab-add" aria-label="記録する" onClick={add}>
          <IconPlus size={28} />
        </button>
        {([
          { id: 'inbox', label: '未確認', icon: <IconInbox size={24} /> },
          { id: 'settings', label: '設定', icon: <IconGear size={24} /> },
        ] as NavItem[]).map((n) => (
          <button key={n.id} className={tab === n.id ? 'active' : ''} aria-current={tab === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
            {n.icon}
            <span>{n.label}</span>
            {badge(n.id)}
          </button>
        ))}
      </nav>

      {editing && (
        <TxForm
          {...shared}
          tx={editing.tx}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            shared.changed();
            toast(msg);
          }}
        />
      )}

      {toastMsg && (
        <div className={`toast${toastMsg.error ? ' toast-error' : ''}`} role="status">
          {toastMsg.text}
        </div>
      )}
    </div>
  );
}
