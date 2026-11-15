import { useCallback, useEffect, useState } from 'react';
import type { Category, Transaction } from '../../api/src/types';
import { api, AuthError } from './api';
import { handleRedirect, isLoggedIn, login } from './auth';
import { Home } from './components/Home';
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
        <h1>家計簿</h1>
        <button className="btn btn-primary btn-wide" onClick={() => void login()}>ログイン</button>
      </div>
    );
  }
  return <Main onAuthError={() => setPhase({ name: 'login' })} />;
}

type Tab = 'home' | 'list' | 'inbox' | 'settings';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'ホーム', icon: '🏠' },
  { id: 'list', label: '明細', icon: '📋' },
  { id: 'inbox', label: '未確認', icon: '📥' },
  { id: 'settings', label: '設定', icon: '⚙️' },
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
}

function Main({ onAuthError }: { onAuthError: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  const [month, setMonth] = useState(thisMonth);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<Transaction[] | null>(null);
  const [advances, setAdvances] = useState<Transaction[]>([]);
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
  }, [version, handleError]);

  // アプリに戻ってきたとき (ショートカットで記録したあとなど) に最新にする
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && setVersion((v) => v + 1);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!categories) return <div className="center muted">読み込み中…</div>;

  const shared: Shared = {
    categories,
    reloadCategories,
    changed: () => setVersion((v) => v + 1),
    edit: (tx) => setEditing({ tx }),
    toast,
    handleError,
  };
  const inboxCount = unconfirmed?.length ?? 0;

  return (
    <div className="app">
      <main className="content">
        {tab === 'home' && (
          <Home {...shared} month={month} setMonth={setMonth} txs={txs} advances={advances} inboxCount={inboxCount} openInbox={() => setTab('inbox')} />
        )}
        {tab === 'list' && <TxList {...shared} month={month} setMonth={setMonth} txs={txs} />}
        {tab === 'inbox' && <Inbox {...shared} txs={unconfirmed} />}
        {tab === 'settings' && <Settings {...shared} />}
      </main>

      {tab !== 'settings' && (
        <button className="fab" aria-label="記録する" onClick={() => setEditing({})}>＋</button>
      )}

      <nav className="tabbar" aria-label="画面の切り替え">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id} onClick={() => setTab(t.id)}>
            <span className="tab-icon" aria-hidden>{t.icon}</span>
            <span>{t.label}</span>
            {t.id === 'inbox' && inboxCount > 0 && <span className="badge">{inboxCount}</span>}
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
